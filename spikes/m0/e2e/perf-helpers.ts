// 性能测量的共用工具（P3 的 V10 起用，P5 的 V13 性能复用）：统计量、页面与 Worker 的 JS 堆（CDP，只有 Chromium 内核）。
import type { CDPSession } from '@playwright/test';

export function stats(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
    return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1], min: sorted[0], n: sorted.length };
}

export const median = (xs: number[]) => stats(xs).p50;

/** 公式 Worker 的 CDP 会话：自动附加到页面新建的 Worker（只有 Chromium 内核支持）。 */
export function watchWorkers(cdp: CDPSession): Map<string, string> {
    const workers = new Map<string, string>();
    cdp.on('Target.attachedToTarget', (e) => {
        if (e.targetInfo.type === 'worker') workers.set(e.sessionId, e.targetInfo.url);
    });
    cdp.on('Target.detachedFromTarget', (e) => {
        workers.delete(e.sessionId);
    });
    return workers;
}

export async function workerHeap(cdp: CDPSession, sessionId: string): Promise<number | null> {
    let seq = 9000;
    const call = (method: string) => new Promise<Record<string, unknown>>((resolve) => {
        const id = (seq += 1);
        const onMessage = (e: { sessionId?: string; message: string }) => {
            if (e.sessionId !== sessionId) return;
            const m = JSON.parse(e.message) as { id?: number; result?: Record<string, unknown> };
            if (m.id !== id) return;
            cdp.off('Target.receivedMessageFromTarget', onMessage);
            resolve(m.result ?? {});
        };
        cdp.on('Target.receivedMessageFromTarget', onMessage);
        void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) });
    });
    await call('HeapProfiler.collectGarbage');
    const usage = await call('Runtime.getHeapUsage');
    return typeof usage.usedSize === 'number' ? usage.usedSize : null;
}

/** 先强制垃圾回收，再读页面主线程与各个 Worker 的 JS 堆（Runtime.getHeapUsage）。 */
export async function heaps(cdp: CDPSession | null, workers: Map<string, string>) {
    if (cdp == null) return null;
    await cdp.send('HeapProfiler.collectGarbage');
    const main = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    const worker: number[] = [];
    for (const sessionId of workers.keys()) {
        const used = await workerHeap(cdp, sessionId);
        if (used != null) worker.push(used);
    }
    return { main, workers: worker, total: main + worker.reduce((s, x) => s + x, 0) };
}
