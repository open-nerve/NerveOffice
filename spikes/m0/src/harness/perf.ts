// 计时与主线程阻塞（V08、V10）。
// - 同步段（save()、JSON.stringify）直接计时，这段时间主线程完全被占用；
// - 异步段（gzip、哈希）期间的阻塞：Chromium 用 Long Tasks；三个浏览器都用事件循环延迟探针（setTimeout 链的最大间隔）。
import type { EditorHandle } from './create-editor';

export interface LongTaskRecord {
    start: number;
    duration: number;
}

/** Long Tasks 观察器；浏览器不支持时 supported 为 false。 */
export function observeLongTasks(): { supported: boolean; stop(): LongTaskRecord[] } {
    const list: LongTaskRecord[] = [];
    const supported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
    if (!supported) return { supported, stop: () => list };
    const observer = new PerformanceObserver((entries) => {
        for (const e of entries.getEntries()) list.push({ start: e.startTime, duration: e.duration });
    });
    observer.observe({ type: 'longtask', buffered: false });
    return {
        supported,
        stop() {
            observer.takeRecords().forEach((e) => list.push({ start: e.startTime, duration: e.duration }));
            observer.disconnect();
            return list;
        },
    };
}

/** 事件循环延迟探针：两次 setTimeout(0) 回调之间的最大间隔，近似主线程的最长阻塞（分辨率约 4 ms）。 */
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
            running = false;
            return { maxGap, samples };
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
    const tasks = longTasks.stop();
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
    };
}

export function percentile(values: number[], p: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[rank];
}
