// 本机发件箱（P6，00 号计划书 §7.5）：IndexedDB，每个用户的每份文档最多一条记录。
// - 写入是覆盖同一个键，由事务保证原子性（不需要"先写新、再删旧"）；"只删到已确认的序号"在同一个事务里比较后删除；
// - 写入栅栏（P6 审查 R1）：拿到文档的锁之后，把"持有者令牌"写进 holders；之后每次写入、删除都在同一个事务里先核对令牌，
//   不是当前持有者就中止。锁被抢走的标签页即使还有在途的写入（例如 Worker 里正在压缩的一次），也写不进去；
// - 数据库升级时（onversionchange）关闭连接，不阻塞新版本（P6 审查 S5）。
// 主线程与发件箱 Worker 共用（不依赖 DOM）。
import type { Sealed } from './crypto';

export const OUTBOX_DB = 'nerve-outbox';
const RECORDS = 'records';
const HOLDERS = 'holders';

export interface OutboxRecord extends Sealed {
    userId: string;
    docId: string;
    /** 捕获时所基于的服务端修订号。 */
    baseRevision: number;
    writeEpoch: number;
    /** 本地修改序号：在捕获的同步段里分配，严格递增（可以有空号）。 */
    localSeq: number;
    /** 在途上传的请求标识（本 Phase 不上传，恒为 null）。 */
    inflightRequestId: string | null;
    clientBuild: string;
    keyVersion: number;
    /** 捕获时公式还没收齐（持续编辑满 3 秒的捕获可能出现）：恢复时要强制重算（P6 审查 R3）。 */
    formulaPending: boolean;
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

export interface HolderRecord {
    userId: string;
    docId: string;
    /** 标签页实例的令牌（每次打开文档随机生成）。 */
    token: string;
    /** 代次：每次有标签页拿到锁加一。 */
    generation: number;
    since: number;
}

export type Durability = 'default' | 'strict' | 'relaxed';

/** 写入栅栏拒绝：当前标签页已经不是这份文档的持有者。 */
export class FenceError extends Error {
    constructor(message = '不是当前持有者，拒绝写入发件箱') {
        super(message);
        this.name = 'FenceError';
    }
}

export function openOutbox(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(OUTBOX_DB, 2);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: ['userId', 'docId'] });
            if (!db.objectStoreNames.contains(HOLDERS)) db.createObjectStore(HOLDERS, { keyPath: ['userId', 'docId'] });
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('发件箱数据库被其他连接阻塞'));
    });
}

function done(tx: IDBTransaction, fenced: { rejected: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(fenced.rejected ? new FenceError() : tx.error ?? new DOMException('事务中止', 'AbortError'));
        tx.onerror = () => undefined; // 由 onabort 报告
    });
}

/** 在同一个事务里核对持有者令牌；不符就中止事务。then 在核对通过之后执行（仍在这个事务里）。 */
function withFence(tx: IDBTransaction, userId: string, docId: string, token: string | undefined, fenced: { rejected: boolean }, then: () => void): void {
    if (token == null) {
        then();
        return;
    }
    const req = tx.objectStore(HOLDERS).get([userId, docId]);
    req.onsuccess = () => {
        const holder = req.result as HolderRecord | undefined;
        if (holder?.token !== token) {
            fenced.rejected = true;
            tx.abort();
            return;
        }
        then();
    };
}

/** 拿到锁之后登记为持有者，返回新的代次。 */
export async function claimHolder(db: IDBDatabase, userId: string, docId: string, token: string): Promise<number> {
    const tx = db.transaction(HOLDERS, 'readwrite', { durability: 'strict' });
    const store = tx.objectStore(HOLDERS);
    let generation = 1;
    const req = store.get([userId, docId]);
    req.onsuccess = () => {
        generation = ((req.result as HolderRecord | undefined)?.generation ?? 0) + 1;
        store.put({ userId, docId, token, generation, since: Date.now() } satisfies HolderRecord);
    };
    await done(tx, { rejected: false });
    return generation;
}

/** 写入（覆盖）一条记录；fenceToken 给出时先核对持有者。失败时（配额不足、栅栏拒绝）整个事务回滚，原有记录不变。 */
export async function putRecord(db: IDBDatabase, record: OutboxRecord, durability: Durability = 'default', fenceToken?: string): Promise<void> {
    const tx = db.transaction([RECORDS, HOLDERS], 'readwrite', { durability });
    const fenced = { rejected: false };
    withFence(tx, record.userId, record.docId, fenceToken, fenced, () => {
        tx.objectStore(RECORDS).put(record);
    });
    await done(tx, fenced);
}

export async function getRecord(db: IDBDatabase, userId: string, docId: string): Promise<OutboxRecord | null> {
    const tx = db.transaction(RECORDS, 'readonly');
    const req = tx.objectStore(RECORDS).get([userId, docId]);
    await done(tx, { rejected: false });
    return (req.result as OutboxRecord | undefined) ?? null;
}

export async function getHolder(db: IDBDatabase, userId: string, docId: string): Promise<HolderRecord | null> {
    const tx = db.transaction(HOLDERS, 'readonly');
    const req = tx.objectStore(HOLDERS).get([userId, docId]);
    await done(tx, { rejected: false });
    return (req.result as HolderRecord | undefined) ?? null;
}

export async function listRecords(db: IDBDatabase, userId: string): Promise<OutboxRecord[]> {
    const tx = db.transaction(RECORDS, 'readonly');
    const req = tx.objectStore(RECORDS).getAll(IDBKeyRange.bound([userId, ''], [userId, '\uffff']));
    await done(tx, { rejected: false });
    return req.result as OutboxRecord[];
}

/**
 * 服务端确认到 confirmedSeq 之后：只有记录的序号不大于它（且内容哈希相同，给出时）才删除——确认之后又写入的新记录保留。
 * fenceToken 给出时先核对持有者：失去锁的标签页不再处理确认的删除。
 */
export async function deleteUpTo(db: IDBDatabase, userId: string, docId: string, confirmedSeq: number, options: { fenceToken?: string; contentHash?: string } = {}): Promise<boolean> {
    const tx = db.transaction([RECORDS, HOLDERS], 'readwrite');
    const fenced = { rejected: false };
    let deleted = false;
    withFence(tx, userId, docId, options.fenceToken, fenced, () => {
        const store = tx.objectStore(RECORDS);
        const req = store.get([userId, docId]);
        req.onsuccess = () => {
            const rec = req.result as OutboxRecord | undefined;
            if (rec != null && rec.localSeq <= confirmedSeq && (options.contentHash == null || rec.contentHash === options.contentHash)) {
                store.delete([userId, docId]);
                deleted = true;
            }
        };
    });
    await done(tx, fenced);
    return deleted;
}

export async function clearUser(db: IDBDatabase, userId: string): Promise<void> {
    const tx = db.transaction([RECORDS, HOLDERS], 'readwrite');
    tx.objectStore(RECORDS).delete(IDBKeyRange.bound([userId, ''], [userId, '\uffff']));
    tx.objectStore(HOLDERS).delete(IDBKeyRange.bound([userId, ''], [userId, '\uffff']));
    await done(tx, { rejected: false });
}
