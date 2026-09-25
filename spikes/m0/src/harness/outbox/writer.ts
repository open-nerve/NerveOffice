// 发件箱的写入段（P6）：去重哈希 → gzip → 加密 → 写入 IndexedDB。主线程与发件箱 Worker 共用同一段代码（不依赖 DOM）。
// - 序号由调用方在捕获的同步段里分配（P6 审查 G2：两次捕获并发时不能得到同一个序号）；
// - 同一份文档的写入串行执行（Worker 会并发处理消息，这里按文档排队），保证后分配序号的内容后写入；
// - 写入带持有者令牌，由存储层的栅栏核对（store.ts，P6 审查 R1）。
import type { UserKey } from './crypto';
import type { Durability, OutboxRecord } from './store';

import { aadOf, gzipBytes, seal, sha256Hex } from './crypto';
import { putRecord } from './store';

/** 记录的身份与元数据（00 号计划书 §7.5）。 */
export interface OutboxTarget {
    userId: string;
    docId: string;
    baseRevision: number;
    writeEpoch: number;
    clientBuild: string;
    /** V15：快照所含的最后一条 mutation 日志（恢复时只重放序号更大的条目）。 */
    logId?: string;
    logSeq?: number;
}

export interface WriteOptions {
    durability: Durability;
    /** 内容与上次相同也写（测量用）。 */
    force?: boolean;
    /** 捕获的同步段里分配的序号。 */
    localSeq: number;
    /** 持有者令牌（写入栅栏）；不给出时不核对（测量用的手动写入）。 */
    fenceToken?: string;
    /** 捕获时公式还没收齐。 */
    formulaPending: boolean;
}

export interface WriteTimings {
    hashMs: number;
    gzipMs: number;
    encryptMs: number;
    putMs: number;
    gzipBytes: number;
    cipherBytes: number;
    /** 内容与上次写入的相同，跳过（序号作废，留下空号）。 */
    skipped: boolean;
    localSeq: number;
    /** 写入失败的错误名（例如 QuotaExceededError、FenceError）；成功为 null。 */
    error: string | null;
}

/** 测试钩子（只在主线程放置时生效）：写入 IndexedDB 之前调用，用来在提交附近杀进程（P6 审查 G5）。 */
type PutHook = () => void;

export class OutboxWriter {
    private readonly lastHash = new Map<string, string>();
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(private readonly db: IDBDatabase, private readonly key: UserKey) {}

    /** 恢复之后，用恢复的记录的内容哈希做去重的起点。 */
    setLastHash(docId: string, contentHash: string | undefined): void {
        if (contentHash != null) this.lastHash.set(docId, contentHash);
    }

    write(target: OutboxTarget, bytes: Uint8Array<ArrayBuffer>, options: WriteOptions): Promise<WriteTimings> {
        const prev = this.queues.get(target.docId) ?? Promise.resolve();
        const next = prev.then(() => this.writeNow(target, bytes, options), () => this.writeNow(target, bytes, options));
        this.queues.set(target.docId, next.catch(() => undefined));
        return next;
    }

    private async writeNow(target: OutboxTarget, bytes: Uint8Array<ArrayBuffer>, options: WriteOptions): Promise<WriteTimings> {
        const t0 = performance.now();
        const contentHash = await sha256Hex(bytes);
        const t1 = performance.now();
        const base = { hashMs: t1 - t0, gzipMs: 0, encryptMs: 0, putMs: 0, gzipBytes: 0, cipherBytes: 0, localSeq: options.localSeq, error: null };
        if (options.force !== true && this.lastHash.get(target.docId) === contentHash) return { ...base, skipped: true };
        const gz = await gzipBytes(bytes);
        const t2 = performance.now();
        const meta = { ...target, localSeq: options.localSeq, keyVersion: this.key.version, formulaPending: options.formulaPending };
        const sealed = await seal(this.key.key, gz, aadOf(meta));
        const t3 = performance.now();
        const record: OutboxRecord = {
            ...meta,
            ...sealed,
            inflightRequestId: null,
            contentHash,
            jsonBytes: bytes.byteLength,
            gzipBytes: gz.byteLength,
            updatedAt: Date.now(),
        };
        let error: string | null = null;
        try {
            (globalThis as { __p6OnPut?: PutHook }).__p6OnPut?.();
            await putRecord(this.db, record, options.durability, options.fenceToken);
            this.lastHash.set(target.docId, contentHash);
        } catch (e) {
            error = e instanceof DOMException || e instanceof Error ? e.name : String(e);
        }
        const t4 = performance.now();
        return {
            hashMs: t1 - t0,
            gzipMs: t2 - t1,
            encryptMs: t3 - t2,
            putMs: t4 - t3,
            gzipBytes: gz.byteLength,
            cipherBytes: sealed.ciphertext.byteLength,
            skipped: false,
            localSeq: options.localSeq,
            error,
        };
    }
}
