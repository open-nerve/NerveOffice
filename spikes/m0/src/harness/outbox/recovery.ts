// 恢复（P6，00 号计划书 §7.5）：拿到文档的锁之后，读发件箱里这份文档的记录，重新向服务端取密钥解密、解压、解析，
// 再与服务端当前的修订号比较：
// - 相等：可以一键恢复（restorable）；
// - 不等：别人在中间保存过，是真冲突（conflict），不自动恢复（另存为副本由 M4 实现）；
// - 解密失败（密钥被吊销、记录被篡改或调换）：记录作废（undecryptable）。
import type { UserKey } from './crypto';
import type { OutboxRecord } from './store';

import { aadOf, gunzipBytes, unseal } from './crypto';
import { getRecord } from './store';

export type RecoveryStatus = 'none' | 'restorable' | 'conflict' | 'undecryptable';

export interface RecoveryInfo {
    status: RecoveryStatus;
    /** 记录的元数据（不含密文）。 */
    record: Omit<OutboxRecord, 'iv' | 'ciphertext'> | null;
    serverRevision: number | null;
    error: string | null;
    timings: { readMs: number; decryptMs: number; gunzipMs: number; parseMs: number };
}

export interface RecoveryResult extends RecoveryInfo {
    /** 解密成功时的快照（restorable 与 conflict）。 */
    snapshot: Record<string, unknown> | null;
}

/** 服务端当前的修订号；文档不存在时为 null。 */
export async function serverRevision(docId: string): Promise<number | null> {
    const res = await fetch(`/api/docs/${encodeURIComponent(docId)}`, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return null;
    return Number(res.headers.get('X-Revision') ?? '0');
}

export async function inspectRecovery(db: IDBDatabase, userId: string, docId: string, key: UserKey): Promise<RecoveryResult> {
    const timings = { readMs: 0, decryptMs: 0, gunzipMs: 0, parseMs: 0 };
    const t0 = performance.now();
    const rec = await getRecord(db, userId, docId);
    timings.readMs = performance.now() - t0;
    if (rec == null) return { status: 'none', record: null, serverRevision: null, error: null, timings, snapshot: null };
    const { iv: _iv, ciphertext: _c, ...meta } = rec;
    const revision = await serverRevision(docId);
    let snapshot: Record<string, unknown> | null = null;
    try {
        const t1 = performance.now();
        const gz = await unseal(key.key, rec, aadOf(userId, docId, rec.localSeq));
        const t2 = performance.now();
        const bytes = await gunzipBytes(gz);
        const t3 = performance.now();
        snapshot = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const t4 = performance.now();
        Object.assign(timings, { decryptMs: t2 - t1, gunzipMs: t3 - t2, parseMs: t4 - t3 });
    } catch (e) {
        return { status: 'undecryptable', record: meta, serverRevision: revision, error: e instanceof DOMException ? e.name : String(e), timings, snapshot: null };
    }
    const same = revision == null ? rec.baseRevision === 0 : revision === rec.baseRevision;
    return { status: same ? 'restorable' : 'conflict', record: meta, serverRevision: revision, error: null, timings, snapshot };
}
