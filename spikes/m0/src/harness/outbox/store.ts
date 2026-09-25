// 本机发件箱（P6，00 号计划书 §7.5）：IndexedDB，每个用户的每份文档最多一条记录。
// 写入是覆盖同一个键，由事务保证原子性（不需要"先写新、再删旧"）；"只删到已确认的序号"在同一个事务里比较后删除。
// 主线程与发件箱 Worker 共用（不依赖 DOM）。
import type { Sealed } from './crypto';

export const OUTBOX_DB = 'nerve-outbox';
const STORE = 'records';

export interface OutboxRecord extends Sealed {
    userId: string;
    docId: string;
    /** 捕获时所基于的服务端修订号。 */
    baseRevision: number;
    writeEpoch: number;
    /** 本地修改序号：每写入一次加一。 */
    localSeq: number;
    /** 在途上传的请求标识（本 Phase 不上传，恒为 null）。 */
    inflightRequestId: string | null;
    clientBuild: string;
    keyVersion: number;
    /** 明文（gzip 之前）的 SHA-256：会话内去重用。 */
    contentHash: string;
    jsonBytes: number;
    gzipBytes: number;
    /** Date.now()。 */
    updatedAt: number;
    /** V15：快照所含的最后一条 mutation 日志。 */
    logId?: string;
    logSeq?: number;
}

export type Durability = 'default' | 'strict' | 'relaxed';

export function openOutbox(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(OUTBOX_DB, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE, { keyPath: ['userId', 'docId'] });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('发件箱数据库被其他连接阻塞'));
    });
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new DOMException('事务中止', 'AbortError'));
        tx.onerror = () => undefined; // 由 onabort 报告
    });
}

/** 写入（覆盖）一条记录；失败时（例如 QuotaExceededError）整个事务回滚，原有记录不变。 */
export async function putRecord(db: IDBDatabase, record: OutboxRecord, durability: Durability = 'default'): Promise<void> {
    const tx = db.transaction(STORE, 'readwrite', { durability });
    tx.objectStore(STORE).put(record);
    await done(tx);
}

export async function getRecord(db: IDBDatabase, userId: string, docId: string): Promise<OutboxRecord | null> {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get([userId, docId]);
    await done(tx);
    return (req.result as OutboxRecord | undefined) ?? null;
}

export async function listRecords(db: IDBDatabase, userId: string): Promise<OutboxRecord[]> {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll(IDBKeyRange.bound([userId, ''], [userId, '\uffff']));
    await done(tx);
    return req.result as OutboxRecord[];
}

/** 服务端确认到 confirmedSeq 之后：只有记录的序号不大于它才删除（确认之后又写入的新记录保留）。 */
export async function deleteUpTo(db: IDBDatabase, userId: string, docId: string, confirmedSeq: number): Promise<boolean> {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let deleted = false;
    const req = store.get([userId, docId]);
    req.onsuccess = () => {
        const rec = req.result as OutboxRecord | undefined;
        if (rec != null && rec.localSeq <= confirmedSeq) {
            store.delete([userId, docId]);
            deleted = true;
        }
    };
    await done(tx);
    return deleted;
}

export async function clearUser(db: IDBDatabase, userId: string): Promise<void> {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(IDBKeyRange.bound([userId, ''], [userId, '\uffff']));
    await done(tx);
}
