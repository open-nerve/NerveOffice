// 写入管道（P6，00 号计划书 §7.2 的 ① ②）：save() → 序列化 → 编码 → 去重哈希 → gzip → 加密 → 写入发件箱。
// 两种放置方式（V14-1 比较主线程阻塞）：
// - main：全部在主线程（压缩、加密、写入都是异步 API，实现可能在别的线程上执行，也可能占用主线程）；
// - worker：主线程只做 save()、序列化与编码（SDK 的模型只在主线程上），字节转移给发件箱 Worker。
import type { EditorHandle } from '../create-editor';
import type { LongTaskRecord } from '../perf';
import type { UserKey } from './crypto';
import type { Durability } from './store';
import type { OutboxTarget, WriteTimings } from './writer';

import { observeLongTasks, probeEventLoopLag } from '../perf';
import { openOutbox } from './store';
import { OutboxWriter } from './writer';

export type Placement = 'main' | 'worker';

export interface PipelineResult extends WriteTimings {
    placement: Placement;
    durability: Durability;
    saveMs: number;
    stringifyMs: number;
    encodeMs: number;
    /** 主线程的同步段合计：save() + 序列化 + 编码，期间主线程完全被占用。 */
    syncMs: number;
    /** worker 放置：把字节交给 Worker 到收到结果的时间（含 Worker 里的全部工作）。 */
    workerRoundTripMs: number | null;
    totalMs: number;
    jsonBytes: number;
    /** 同步段之后（异步段）主线程的最长阻塞。 */
    asyncMaxGapMs: number;
    longTasks: LongTaskRecord[] | null;
    startedAt: number;
    finishedAt: number;
}

interface WorkerReply {
    id: number;
    ok: boolean;
    result?: WriteTimings & { workerMs: number };
    error?: string;
}

/** 发件箱 Worker 的客户端：请求按 id 对应。 */
class OutboxWorkerClient {
    private readonly worker = new Worker(new URL('../../workers/outbox.worker.ts', import.meta.url), { type: 'module' });
    private readonly pending = new Map<number, (r: WorkerReply) => void>();
    private next = 1;

    constructor() {
        this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
            this.pending.get(e.data.id)?.(e.data);
            this.pending.delete(e.data.id);
        };
    }

    call(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<WorkerReply> {
        const id = this.next++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, (r) => (r.ok ? resolve(r) : reject(new Error(r.error))));
            this.worker.postMessage({ ...message, id }, transfer);
        });
    }

    terminate(): void {
        this.worker.terminate();
    }
}

export interface OutboxPipeline {
    placement: Placement;
    /** 捕获一次并写入发件箱。 */
    capture(editor: EditorHandle, target: OutboxTarget, options: { durability: Durability; force?: boolean }): Promise<PipelineResult>;
    /** 恢复之后从恢复的记录继续编号。 */
    setSeq(docId: string, localSeq: number, contentHash?: string): Promise<void>;
    dispose(): void;
}

export async function createPipeline(placement: Placement, key: UserKey): Promise<OutboxPipeline> {
    let writer: OutboxWriter | null = null;
    let client: OutboxWorkerClient | null = null;
    if (placement === 'main') writer = new OutboxWriter(await openOutbox(), key);
    else {
        client = new OutboxWorkerClient();
        await client.call({ type: 'init', key });
    }
    const encoder = new TextEncoder();

    return {
        placement,
        async capture(editor, target, options) {
            const longTasks = observeLongTasks();
            const t0 = performance.now();
            const snapshot = editor.save();
            const t1 = performance.now();
            const text = JSON.stringify(snapshot);
            const t2 = performance.now();
            const bytes = encoder.encode(text) as Uint8Array<ArrayBuffer>;
            const t3 = performance.now();
            // 转移给 Worker 之后 bytes 的长度变为 0，先记下
            const jsonBytes = bytes.byteLength;
            const lag = probeEventLoopLag();
            let w: WriteTimings;
            let roundTrip: number | null = null;
            if (writer != null) w = await writer.write(target, bytes, options);
            else {
                const reply = await client!.call({ type: 'write', target, bytes, options }, [bytes.buffer]);
                roundTrip = performance.now() - t3;
                w = reply.result!;
            }
            const t4 = performance.now();
            const gap = lag.stop();
            const tasks = await longTasks.stop();
            return {
                ...w,
                placement,
                durability: options.durability,
                saveMs: t1 - t0,
                stringifyMs: t2 - t1,
                encodeMs: t3 - t2,
                syncMs: t3 - t0,
                workerRoundTripMs: roundTrip,
                totalMs: t4 - t0,
                jsonBytes,
                asyncMaxGapMs: gap.maxGap,
                longTasks: longTasks.supported ? tasks : null,
                startedAt: t0,
                finishedAt: t4,
            };
        },
        async setSeq(docId, localSeq, contentHash) {
            if (writer != null) writer.setSeq(docId, localSeq, contentHash);
            else await client!.call({ type: 'seq', docId, localSeq, contentHash });
        },
        dispose() {
            client?.terminate();
        },
    };
}
