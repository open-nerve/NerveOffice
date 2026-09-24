// 计时与主线程阻塞（V08、V10）。
// - 同步段（save()、JSON.stringify）直接计时，这段时间主线程完全被占用；
// - 异步段（gzip、哈希）期间的阻塞：Chromium 用 Long Tasks；三个浏览器都用事件循环延迟探针（setTimeout 链的最大间隔）。
import type { EditorHandle } from './create-editor';

export interface LongTaskRecord {
    start: number;
    duration: number;
}

/**
 * Long Tasks 观察器；浏览器不支持时 supported 为 false。
 * 长任务的记录在任务结束之后才送达：被测的工作在一个长任务末尾完成、await 的后续代码在同一个任务里调用 stop() 时，
 * 这个任务还没结束，记录会晚到，落进下一段观察。所以 stop() 先让出宏任务与一帧再收集，
 * 并且只保留与观察窗口重叠的任务（结束时刻不早于开始观察的时刻），把上一段测量晚到的记录排除在外。
 */
export function observeLongTasks(): { supported: boolean; stop(): Promise<LongTaskRecord[]> } {
    const list: LongTaskRecord[] = [];
    const since = performance.now();
    const supported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
    if (!supported) return { supported, stop: async () => list };
    const observer = new PerformanceObserver((entries) => {
        for (const e of entries.getEntries()) list.push({ start: e.startTime, duration: e.duration });
    });
    observer.observe({ type: 'longtask', buffered: false });
    return {
        supported,
        async stop() {
            await new Promise((r) => setTimeout(r, 0));
            await new Promise((r) => requestAnimationFrame(r));
            await new Promise((r) => setTimeout(r, 0));
            observer.takeRecords().forEach((e) => list.push({ start: e.startTime, duration: e.duration }));
            observer.disconnect();
            return list.filter((t) => t.start + t.duration >= since);
        },
    };
}

/**
 * 事件循环延迟探针：两次 setTimeout(0) 回调之间的最大间隔，近似主线程的最长阻塞（分辨率约 4 ms）。
 * stop() 把"上一次回调到现在"也算进去：被测的工作在一段长阻塞末尾完成、await 的后续代码在同一个任务里调用 stop() 时，
 * 下一次回调还没轮到执行，不这样算就会漏掉最后这段阻塞。
 */
export function probeEventLoopLag(): { stop(): { maxGap: number; samples: number } } {
    let running = true;
    let last = performance.now();
    let maxGap = 0;
    let samples = 0;
    const tick = () => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        samples += 1;
        if (running) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    return {
        stop() {
            if (running) maxGap = Math.max(maxGap, performance.now() - last);
            running = false;
            return { maxGap, samples };
        },
    };
}

/**
 * 帧间隔探针：两次 requestAnimationFrame 回调之间的最大间隔，即界面最长没有刷新的时间（用户看到的冻结）。
 * 与事件循环延迟探针一样，stop() 把"上一帧到现在"也算进去。
 */
export function probeFrameGap(): { stop(): { maxGap: number; frames: number } } {
    let running = true;
    let last = performance.now();
    let maxGap = 0;
    let frames = 0;
    const frame = () => {
        if (!running) return;
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        frames += 1;
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return {
        stop() {
            if (running) maxGap = Math.max(maxGap, performance.now() - last);
            running = false;
            return { maxGap, frames };
        },
    };
}

/** Chromium 的 JS 堆占用（字节）；其他浏览器返回 null。 */
export function usedJsHeap(): number | null {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return memory?.usedJSHeapSize ?? null;
}

export async function gzip(text: string): Promise<Uint8Array> {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CaptureMeasurement {
    saveMs: number;
    stringifyMs: number;
    /** 同步段合计：save() + JSON.stringify，期间主线程完全被占用。 */
    syncMs: number;
    gzipMs: number;
    hashMs: number;
    totalMs: number;
    jsonBytes: number;
    gzipBytes: number;
    /** 异步段期间的最长阻塞。 */
    asyncMaxGapMs: number;
    longTasks: LongTaskRecord[] | null;
    /** 哈希完成的时刻（performance.now()）：端到端按它计时，不含收集长任务记录时的让出。 */
    finishedAt: number;
}

/** 按平台管道的顺序做一次完整捕获：save() → 序列化 → gzip → SHA-256（00 号计划书 §7.2 的 ①）。 */
export async function measureCapture(editor: EditorHandle): Promise<CaptureMeasurement> {
    const longTasks = observeLongTasks();
    const t0 = performance.now();
    const snapshot = editor.save();
    const t1 = performance.now();
    const text = JSON.stringify(snapshot);
    const t2 = performance.now();
    const lag = probeEventLoopLag();
    const zipped = await gzip(text);
    const t3 = performance.now();
    await sha256Hex(zipped);
    const t4 = performance.now();
    const gap = lag.stop();
    const tasks = await longTasks.stop();
    return {
        saveMs: t1 - t0,
        stringifyMs: t2 - t1,
        syncMs: t2 - t0,
        gzipMs: t3 - t2,
        hashMs: t4 - t3,
        totalMs: t4 - t0,
        jsonBytes: new TextEncoder().encode(text).length,
        gzipBytes: zipped.length,
        asyncMaxGapMs: gap.maxGap,
        longTasks: longTasks.supported ? tasks : null,
        finishedAt: t4,
    };
}

export function percentile(values: number[], p: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[rank];
}
