// V15：mutation 增量日志（P6，00 号计划书 §7.5 的"可选增强"）。只用于验证。
// 记录点：ICommandService.onMutationExecutedForCollab（内部 API，协同插件闭源，开源代码里没有使用者）。
// - 每条 MUTATION 都会送达（包括 onlyLocal、fromCollab、fromSync、syncOnly），这里排除 onlyLocal、fromCollab、fromSync：
//   公式结果写回与 Worker 同步都是 onlyLocal / fromSync，重放时会重新计算；syncOnly 是大表复制的分块，内容要记录；
// - 排除只影响界面的伪 mutation（档案的 changeDetectionExclude）与其他单元（单元格编辑器的内部文档等）；
// - 参数在监听器里同步做结构化克隆：SDK 会在之后原地改写参数（文字编辑的 actions、样式 id、筛选结果、trigger）；
//   执行之后才克隆，执行过程中分配的 id（段落 id 等）已经写进参数；
// - 顺序以执行前取的序号为准：部分命令不等待 mutation 执行完，监听器的触发顺序可能与执行顺序不同。
// 日志按批写进 IndexedDB（每 100 ms 或满 50 条），重放用 syncExecuteCommand(id, params, { fromCollab: true })，在顶层逐条执行。
import type { ICommandInfo, IExecutionOptions, Univer } from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';

import { CommandType, ICommandService } from '@univerjs/core';

export const MUTLOG_DB = 'nerve-mutlog';
const STORE = 'entries';

export interface LogEntry {
    logId: string;
    seq: number;
    id: string;
    params: unknown;
    /** performance.now()，记录时刻。 */
    t: number;
    /** 附带记录（mutation-log-enrich.ts）：自上一条日志以来样式表新增的样式，重放这一条之前先装入。 */
    styles?: Record<string, unknown>;
}

export interface MutationLogStats {
    logged: number;
    skipped: Record<string, number>;
    /** 结构化克隆参数的耗时（毫秒）。 */
    clone: { totalMs: number; maxMs: number };
    cloneErrors: { id: string; error: string }[];
    pending: number;
    flushes: number;
    flush: { totalMs: number; maxMs: number };
    /** 已写入的条目的序列化体积估计（字节，按 JSON 长度）。 */
    bytes: number;
}

export interface MutationLogger {
    logId: string;
    /** 最后分配的序号：快照捕获时记下它，恢复时只重放更大的序号。 */
    seq(): number;
    stats(): MutationLogStats;
    flush(): Promise<void>;
    dispose(): void;
}

function openLog(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(MUTLOG_DB, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE, { keyPath: ['logId', 'seq'] });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new DOMException('事务中止', 'AbortError'));
    });
}

export interface MutationLoggerOptions {
    exclude: string[];
    flushMs?: number;
    batch?: number;
    /** 参数补全（mutation-log-enrich.ts）：记录时从模型读回处理器里随机生成的值。 */
    enrich?: (id: string, params: Record<string, unknown>) => Record<string, unknown>;
    /** 附带记录：每条日志附上的样式增量（mutation-log-enrich.ts 的 createStyleTracker）。 */
    styles?: () => Record<string, unknown> | null;
}

export function startMutationLogger(univer: Univer, unitId: string, logId: string, options: MutationLoggerOptions): MutationLogger {
    const commandService = univer.__getInjector().get(ICommandService);
    const flushMs = options.flushMs ?? 100;
    const batch = options.batch ?? 50;
    const order = new WeakMap<ICommandInfo, number>();
    let counter = 0;
    let lastSeq = 0;
    const buffer: LogEntry[] = [];
    const stats: MutationLogStats = { logged: 0, skipped: {}, clone: { totalMs: 0, maxMs: 0 }, cloneErrors: [], pending: 0, flushes: 0, flush: { totalMs: 0, maxMs: 0 }, bytes: 0 };
    const skip = (reason: string) => {
        stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
    };
    const dbPromise = openLog();
    let flushing: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = async (): Promise<void> => {
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
        while (flushing != null) await flushing;
        if (buffer.length === 0) return;
        const items = buffer.splice(0, buffer.length);
        flushing = (async () => {
            const t0 = performance.now();
            const db = await dbPromise;
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const e of items) store.put(e);
            await done(tx);
            const ms = performance.now() - t0;
            stats.flushes += 1;
            stats.flush.totalMs += ms;
            stats.flush.maxMs = Math.max(stats.flush.maxMs, ms);
        })();
        try {
            await flushing;
        } finally {
            flushing = null;
        }
    };
    const schedule = () => {
        if (buffer.length >= batch) void flush();
        else if (timer == null) timer = setTimeout(() => void flush(), flushMs);
    };

    const d1 = commandService.beforeCommandExecuted((info) => {
        if (info.type === CommandType.MUTATION) order.set(info, ++counter);
    });
    const d2 = commandService.onMutationExecutedForCollab((info: ICommandInfo, opts?: IExecutionOptions) => {
        // 记录器绝不抛错：SDK 不捕获监听器的异常，抛错会跳过后面的监听器
        try {
            if (opts?.onlyLocal) return skip('onlyLocal');
            if (opts?.fromCollab) return skip('fromCollab');
            if ((opts as Record<string, unknown> | undefined)?.fromSync) return skip('fromSync');
            if (options.exclude.includes(info.id)) return skip('excluded');
            const pu = (info.params as { unitId?: string } | undefined)?.unitId;
            if (pu != null && pu !== unitId) return skip('otherUnit');
            const seq = order.get(info) ?? ++counter;
            const t0 = performance.now();
            let params: unknown;
            try {
                params = structuredClone(info.params);
                if (options.enrich != null && params != null) params = options.enrich(info.id, params as Record<string, unknown>);
            } catch (e) {
                stats.cloneErrors.push({ id: info.id, error: e instanceof Error ? e.message : String(e) });
                return;
            }
            const ms = performance.now() - t0;
            stats.clone.totalMs += ms;
            stats.clone.maxMs = Math.max(stats.clone.maxMs, ms);
            stats.logged += 1;
            lastSeq = Math.max(lastSeq, seq);
            const styles = options.styles?.() ?? undefined;
            buffer.push({ logId, seq, id: info.id, params, t: performance.now(), ...(styles != null ? { styles } : {}) });
            schedule();
        } catch (e) {
            stats.cloneErrors.push({ id: info.id, error: `记录失败：${e instanceof Error ? e.message : String(e)}` });
        }
    });

    return {
        logId,
        seq: () => lastSeq,
        stats: () => ({ ...stats, pending: buffer.length }),
        flush,
        dispose: () => {
            d1.dispose();
            d2.dispose();
            void flush();
        },
    };
}

/** 读出某份日志中序号大于 afterSeq 的条目（按序号排序）。 */
export async function readLog(logId: string, afterSeq = 0): Promise<LogEntry[]> {
    const db = await openLog();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll(IDBKeyRange.bound([logId, afterSeq], [logId, Number.MAX_SAFE_INTEGER], true, false));
    await done(tx);
    db.close();
    return (req.result as LogEntry[]).sort((a, b) => a.seq - b.seq);
}

export async function clearLog(logId: string): Promise<void> {
    const db = await openLog();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(IDBKeyRange.bound([logId, 0], [logId, Number.MAX_SAFE_INTEGER]));
    await done(tx);
    db.close();
}

export interface ReplayResult {
    executed: number;
    failed: { seq: number; id: string; error: string }[];
    ms: number;
}

/** 按序号逐条在顶层重放（fromCollab：保留公式重算与渲染，不写撤销栈）；before 在每条执行前调用（装入附带的样式）。 */
export function replayEntries(univerAPI: FUniver, entries: LogEntry[], before?: (e: LogEntry) => void): ReplayResult {
    const t0 = performance.now();
    const failed: ReplayResult['failed'] = [];
    let executed = 0;
    for (const e of entries) {
        try {
            before?.(e);
            const ok = univerAPI.syncExecuteCommand(e.id, e.params as object, { fromCollab: true });
            if (ok === false) failed.push({ seq: e.seq, id: e.id, error: '返回 false' });
            else executed += 1;
        } catch (error) {
            failed.push({ seq: e.seq, id: e.id, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        }
    }
    return { executed, failed, ms: performance.now() - t0 };
}
