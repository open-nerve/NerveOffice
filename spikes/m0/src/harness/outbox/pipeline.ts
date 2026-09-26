// 写入管道（P6，00 号计划书 §7.2 的 ① ②）：save() → 序列化 → 编码 → 去重哈希 → gzip → 加密 → 写入发件箱。
// 两种放置方式（V14-1 比较主线程阻塞）：
// - main：全部在主线程（压缩、加密、写入都是异步 API，实现可能在别的线程上执行，也可能占用主线程）；
// - worker：主线程只做 save()、序列化与编码（SDK 的模型只在主线程上），字节转移给发件箱 Worker。
// 捕获串行执行，序号在 save() 的同步段里分配（P6 审查 G2）：后捕获的内容序号更大，也后写入。
import type { EditorHandle } from '../create-editor';
import type { LongTaskRecord } from '../perf';
import type { UserKey } from './crypto';
import type { Durability } from './store';
import type { OutboxTarget, WriteOptions, WriteTimings } from './writer';

import { observeLongTasks, probeEventLoopLag } from '../perf';
import { sha256Hex } from './crypto';
import { openOutbox } from './store';
import { OutboxWriter } from './writer';

export type Placement = 'main' | 'worker';

export interface PipelineResult extends WriteTimings {
    placement: Placement;
    durability: Durability;
    formulaPending: boolean;
    saveMs: number;
    stringifyMs: number;
    encodeMs: number;
    /** 主线程的同步段合计：save() + 序列化 + 编码，期间主线程完全被占用。 */
    syncMs: number;
    /** worker 放置：把字节交给 Worker 到收到结果的时间（含 Worker 里的全部工作）。 */
    workerRoundTripMs: number | null;
    /**
     * worker 放置：往返拆成三段——消息送到 Worker、Worker 里的处理、结果送回主线程。
     * 两端各用 timeOrigin + now() 换算到同一时间轴（WebKit 的精度为 1 ms）；用来定位往返里多出来的时间（P6 收尾）。
     */
    toWorkerMs: number | null;
    workerMs: number | null;
    fromWorkerMs: number | null;
    totalMs: number;
    jsonBytes: number;
    /** 同步段之后（异步段）主线程的最长阻塞。 */
    asyncMaxGapMs: number;
    longTasks: LongTaskRecord[] | null;
    startedAt: number;
    finishedAt: number;
}

export interface CaptureOptions {
    durability: Durability;
    force?: boolean;
    /** 持有者令牌（写入栅栏）。 */
    fenceToken?: string;
    formulaPending?: boolean;
    /** 在 save() 之后、同一个同步段里调用：返回这次快照所含的日志位置等（V15）。 */
    extra?: () => Partial<OutboxTarget>;
}

interface WorkerReply {
    id: number;
    ok: boolean;
    result?: WriteTimings & { workerMs: number; receivedAt: number; repliedAt: number };
    error?: string;
}

/** 发件箱 Worker 的客户端：请求按 id 对应；Worker 出错或崩溃时，在途的请求全部失败（P6 审查 S5）。 */
class OutboxWorkerClient {
    private readonly worker = new Worker(new URL('../../workers/outbox.worker.ts', import.meta.url), { type: 'module' });
    private readonly pending = new Map<number, { resolve: (r: WorkerReply) => void; reject: (e: Error) => void }>();
    private next = 1;

    constructor() {
        this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
            const p = this.pending.get(e.data.id);
            this.pending.delete(e.data.id);
            if (p == null) return;
            if (e.data.ok) p.resolve(e.data);
            else p.reject(new Error(e.data.error));
        };
        const fail = (message: string) => {
            for (const p of this.pending.values()) p.reject(new Error(message));
            this.pending.clear();
        };
        this.worker.onerror = (e) => fail(`发件箱 Worker 出错：${e.message}`);
        this.worker.onmessageerror = () => fail('发件箱 Worker 的消息无法反序列化');
    }

    call(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<WorkerReply> {
        const id = this.next++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...message, id }, transfer);
        });
    }

    terminate(): void {
        this.worker.terminate();
        for (const p of this.pending.values()) p.reject(new Error('发件箱 Worker 已终止'));
        this.pending.clear();
    }
}

export interface OutboxPipeline {
    placement: Placement;
    /** 捕获一次并写入发件箱（串行）。 */
    capture(editor: EditorHandle, target: OutboxTarget, options: CaptureOptions): Promise<PipelineResult>;
    /** 恢复之后从恢复的记录继续编号，并用它的内容哈希做去重的起点。 */
    continueFrom(docId: string, localSeq: number, contentHash?: string): Promise<void>;
    dispose(): void;
}

/**
 * 两个对照选项（P6 收尾，报告 §2.3 第 11 条：WebKit 的 Worker 空闲之后，第一次异步操作偶尔多等约 1 秒）：
 * - hashOn：Worker 放置时去重哈希在哪里算。缺省在 Worker 里；'main' 时主线程在转移字节之前算好（异步，不占用主线程）；
 * - keepAlive：Worker 里保持一个 100 ms 的空定时器。
 */
export async function createPipeline(placement: Placement, key: UserKey, options: { hashOn?: 'worker' | 'main'; keepAlive?: boolean } = {}): Promise<OutboxPipeline> {
    const hashOnMain = placement === 'worker' && options.hashOn === 'main';
    let writer: OutboxWriter | null = null;
    let client: OutboxWorkerClient | null = null;
    if (placement === 'main') writer = new OutboxWriter(await openOutbox(), key);
    else {
        client = new OutboxWorkerClient();
        await client.call({ type: 'init', key, keepAlive: options.keepAlive === true });
    }
    const encoder = new TextEncoder();
    const seqs = new Map<string, number>();
    let queue: Promise<unknown> = Promise.resolve();

    const captureNow = async (editor: EditorHandle, target: OutboxTarget, options: CaptureOptions): Promise<PipelineResult> => {
        const longTasks = observeLongTasks();
        const t0 = performance.now();
        const snapshot = editor.save();
        // 与 save() 在同一个同步段里：序号与日志位置都对应这份快照
        const localSeq = (seqs.get(target.docId) ?? 0) + 1;
        seqs.set(target.docId, localSeq);
        const fullTarget = { ...target, ...(options.extra?.() ?? {}) };
        const t1 = performance.now();
        const text = JSON.stringify(snapshot);
        const t2 = performance.now();
        const bytes = encoder.encode(text) as Uint8Array<ArrayBuffer>;
        const t3 = performance.now();
        // 转移给 Worker 之后 bytes 的长度变为 0，先记下
        const jsonBytes = bytes.byteLength;
        const lag = probeEventLoopLag();
        const writeOptions: WriteOptions = { durability: options.durability, force: options.force, localSeq, fenceToken: options.fenceToken, formulaPending: options.formulaPending ?? false };
        let w: WriteTimings;
        let roundTrip: number | null = null;
        let legs: { toWorkerMs: number; workerMs: number; fromWorkerMs: number } | null = null;
        if (writer != null) w = await writer.write(fullTarget, bytes, writeOptions);
        else {
            let mainHashMs: number | null = null;
            if (hashOnMain) {
                const h0 = performance.now();
                writeOptions.contentHash = await sha256Hex(bytes);
                mainHashMs = performance.now() - h0;
            }
            const sentAt = performance.timeOrigin + performance.now();
            const reply = await client!.call({ type: 'write', target: fullTarget, bytes, options: writeOptions }, [bytes.buffer]);
            const gotAt = performance.timeOrigin + performance.now();
            roundTrip = performance.now() - t3;
            const { workerMs, receivedAt, repliedAt, ...timings } = reply.result!;
            w = mainHashMs == null ? timings : { ...timings, hashMs: mainHashMs };
            legs = { toWorkerMs: receivedAt - sentAt, workerMs, fromWorkerMs: gotAt - repliedAt };
        }
        const t4 = performance.now();
        const gap = lag.stop();
        const tasks = await longTasks.stop();
        return {
            ...w,
            placement,
            durability: options.durability,
            formulaPending: writeOptions.formulaPending,
            saveMs: t1 - t0,
            stringifyMs: t2 - t1,
            encodeMs: t3 - t2,
            syncMs: t3 - t0,
            workerRoundTripMs: roundTrip,
            toWorkerMs: legs?.toWorkerMs ?? null,
            workerMs: legs?.workerMs ?? null,
            fromWorkerMs: legs?.fromWorkerMs ?? null,
            totalMs: t4 - t0,
            jsonBytes,
            asyncMaxGapMs: gap.maxGap,
            longTasks: longTasks.supported ? tasks : null,
            startedAt: t0,
            finishedAt: t4,
        };
    };

    return {
        placement,
        capture(editor, target, options) {
            const run = queue.then(() => captureNow(editor, target, options), () => captureNow(editor, target, options));
            queue = run.catch(() => undefined);
            return run;
        },
        async continueFrom(docId, localSeq, contentHash) {
            seqs.set(docId, Math.max(seqs.get(docId) ?? 0, localSeq));
            if (writer != null) writer.setLastHash(docId, contentHash);
            else await client!.call({ type: 'hash', docId, contentHash });
        },
        dispose() {
            client?.terminate();
        },
    };
}
