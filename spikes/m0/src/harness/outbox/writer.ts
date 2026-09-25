// 发件箱的写入段（P6）：去重哈希 → gzip → 加密 → 写入 IndexedDB。主线程与发件箱 Worker 共用同一段代码（不依赖 DOM）。
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
}

export interface WriteTimings {
    hashMs: number;
    gzipMs: number;
    encryptMs: number;
    putMs: number;
    gzipBytes: number;
    cipherBytes: number;
    /** 内容与上次写入的相同，跳过。 */
    skipped: boolean;
    localSeq: number;
    /** 写入失败的错误名（例如 QuotaExceededError）；成功为 null。 */
    error: string | null;
}

export class OutboxWriter {
    private readonly lastHash = new Map<string, string>();
    private readonly seq = new Map<string, number>();

    constructor(private readonly db: IDBDatabase, private readonly key: UserKey) {}

    /** 恢复之后从恢复的记录继续编号。 */
    setSeq(docId: string, localSeq: number, contentHash?: string): void {
        this.seq.set(docId, localSeq);
        if (contentHash != null) this.lastHash.set(docId, contentHash);
    }

    async write(target: OutboxTarget, bytes: Uint8Array<ArrayBuffer>, options: WriteOptions): Promise<WriteTimings> {
        const t0 = performance.now();
        const contentHash = await sha256Hex(bytes);
        const t1 = performance.now();
        const localSeq = (this.seq.get(target.docId) ?? 0) + 1;
        const base = { hashMs: t1 - t0, gzipMs: 0, encryptMs: 0, putMs: 0, gzipBytes: 0, cipherBytes: 0, localSeq: localSeq - 1, error: null };
        if (options.force !== true && this.lastHash.get(target.docId) === contentHash) return { ...base, skipped: true };
        const gz = await gzipBytes(bytes);
        const t2 = performance.now();
        const sealed = await seal(this.key.key, gz, aadOf(target.userId, target.docId, localSeq));
        const t3 = performance.now();
        const record: OutboxRecord = {
            ...target,
            ...sealed,
            localSeq,
            inflightRequestId: null,
            keyVersion: this.key.version,
            contentHash,
            jsonBytes: bytes.byteLength,
            gzipBytes: gz.byteLength,
            updatedAt: Date.now(),
        };
        let error: string | null = null;
        try {
            await putRecord(this.db, record, options.durability);
            this.seq.set(target.docId, localSeq);
            this.lastHash.set(target.docId, contentHash);
        } catch (e) {
            error = e instanceof DOMException ? e.name : e instanceof Error ? e.message : String(e);
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
            localSeq: error == null ? localSeq : localSeq - 1,
            error,
        };
    }
}
