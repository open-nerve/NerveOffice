// 本机发件箱原型（P6）：把密钥、锁、恢复、写入管道与自动保存装到一份打开的文档上。只用于验证，M4 按正式流程重写。
// 流程（00 号计划书 §7.5）：取密钥 → 申请文档的锁 →
// - 拿到锁：登记为持有者（写入栅栏的令牌）→ 检查发件箱里有没有这份文档的未同步记录 → 没有就开始自动保存；
//   有就进入只读，等用户选择"恢复"或"放弃"；
// - 拿不到锁：另一个标签页正在编辑，进入只读、不写发件箱，并排队等锁。接手时先看服务端的修订号，
//   比打开时新就先从服务端重新加载（P6 审查 G3），再走上面的检查；
// - 锁被抢走：立即停止自动保存，进入只读；在途的写入由存储层的栅栏拒绝（P6 审查 R1）。
import type { EditorHandle } from '../create-editor';
import type { AutosaveHandle } from './autosave';
import type { Placement, PipelineResult } from './pipeline';
import type { RecoveryInfo, RecoveryResult } from './recovery';
import type { Durability } from './store';
import type { TabLock } from './tab-lock';

import { waitForCapture } from '../capture-timing';
import { startAutosave } from './autosave';
import { fetchUserKey } from './crypto';
import { createPipeline } from './pipeline';
import { inspectRecovery, serverRevision } from './recovery';
import { claimHolder, deleteUpTo, openOutbox } from './store';
import { acquireDocLock } from './tab-lock';

export type OutboxState = 'editing' | 'busy' | 'lost' | 'recovery-pending';

export interface OutboxHandle {
    user: string;
    docId: string;
    placement: Placement;
    durability: Durability;
    /** 本标签页的持有者令牌。 */
    token: string;
    lock(): TabLock;
    state(): OutboxState;
    /** 拿到锁时登记的代次（没拿到锁时为 null）。 */
    generation(): number | null;
    /** 打开时检查到的未同步记录（不含快照内容）。 */
    recovery(): RecoveryInfo | null;
    autosave(): AutosaveHandle | null;
    /** 接手时从服务端重新加载的次数（P6 审查 G3）。 */
    reloads(): number;
    /**
     * 手动捕获并写入（测量与填充配额用）；docId 可以换成别的键。
     * bypassLockCheck 只用于验证写入栅栏：跳过本标签页的锁状态检查，写入仍然带令牌、由存储层核对。
     */
    capture(options?: { force?: boolean; durability?: Durability; docId?: string; bypassLockCheck?: boolean }): Promise<PipelineResult>;
    /** 用发件箱里的快照重建编辑器（带"公式待更新"标记时强制重算，收齐后补捕获），然后开始自动保存。 */
    restore(): Promise<void>;
    /** 放弃本机的未同步修改。 */
    discard(): Promise<void>;
    /** 抢锁（生产上对应"在这里继续编辑"）：原持有者失去锁、停止写入；本标签页接手（登记持有者、对齐服务端、检查发件箱）。 */
    steal(): Promise<void>;
    /** 重新检查发件箱（不改变状态）；docId 缺省为本文档。 */
    inspect(docId?: string): Promise<RecoveryInfo>;
    dispose(): void;
}

export interface InstallOutboxOptions {
    editor: () => EditorHandle;
    /** 用给定的快照重建编辑器（宿主页面实现）；forceCalc 时打开后强制全量重算公式。 */
    reopen: (data: Record<string, unknown>, options?: { forceCalc?: boolean }) => Promise<EditorHandle>;
    user: string;
    docId: string;
    revision: number;
    placement: Placement;
    /** Worker 放置时去重哈希在哪里算（缺省在 Worker 里）。 */
    hashOn?: 'worker' | 'main';
    /** Worker 放置时在 Worker 里保持一个空定时器（对照用）。 */
    keepAlive?: boolean;
    durability: Durability;
    /** V15：mutation 日志的当前位置（在 save() 的同步段里读取）。 */
    logMark?: () => { logId: string; logSeq: number } | null;
}

const withoutSnapshot = (r: RecoveryResult): RecoveryInfo => {
    const { snapshot: _s, ...info } = r;
    return info;
};

/** 只读与可编辑的切换：表格用 FWorkbook.setEditable，文字文档用 FDocument 的权限（与 P3 的阅读模式同一组公开 API）。 */
async function setEditable(editor: EditorHandle, editable: boolean): Promise<void> {
    if (editor.kind === 'sheet') editor.univerAPI.getActiveWorkbook()?.setEditable(editable);
    else await editor.univerAPI.getActiveDocument()?.getPermission().setEditable(editable);
}

async function fetchServerDocument(docId: string): Promise<{ data: Record<string, unknown>; revision: number } | null> {
    const res = await fetch(`/api/docs/${encodeURIComponent(docId)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return { data: (await res.json()) as Record<string, unknown>, revision: Number(res.headers.get('X-Revision') ?? '0') };
}

export async function installOutbox(options: InstallOutboxOptions): Promise<OutboxHandle> {
    const { editor, reopen, user, docId, placement, durability } = options;
    let revision = options.revision;
    const token = crypto.randomUUID();
    const key = await fetchUserKey(user);
    let lock = await acquireDocLock(docId);
    let state: OutboxState = 'busy';
    let generation: number | null = null;
    let reloads = 0;
    const db = await openOutbox();
    const pipeline = await createPipeline(placement, key, { hashOn: options.hashOn, keepAlive: options.keepAlive });
    const target = (id = docId) => ({ userId: user, docId: id, baseRevision: revision, writeEpoch: 0, clientBuild: 'm0-p6' });
    const extra = () => options.logMark?.() ?? {};
    let autosave: AutosaveHandle | null = null;
    let recovery: RecoveryResult | null = null;
    const canWrite = () => state === 'editing' && lock.state() === 'held';

    const start = () => {
        autosave?.stop();
        autosave = startAutosave(editor(), (formulaPending, force) => pipeline.capture(editor(), target(), { durability, fenceToken: token, formulaPending, force, extra }), { canWrite });
    };
    const enter = async (next: OutboxState) => {
        state = next;
        await setEditable(editor(), next === 'editing');
    };

    /** 拿到锁之后：登记为持有者；接手时先对齐服务端；检查发件箱，没有未同步记录就开始自动保存。 */
    const onHeld = async (held: TabLock, takeover: boolean) => {
        lock = held;
        held.onLost(() => {
            autosave?.stop();
            void enter('lost');
        });
        generation = await claimHolder(db, user, docId, token);
        if (takeover) {
            const current = await serverRevision(docId);
            if (current != null && current !== revision) {
                const fresh = await fetchServerDocument(docId);
                if (fresh != null) {
                    await reopen(fresh.data);
                    revision = fresh.revision;
                    reloads += 1;
                }
            }
        }
        recovery = await inspectRecovery(db, user, docId, key);
        if (recovery.record != null) await pipeline.continueFrom(docId, recovery.record.localSeq);
        if (recovery.status === 'none') {
            await enter('editing');
            start();
        } else await enter('recovery-pending');
    };

    if (lock.state() === 'held') await onHeld(lock, false);
    else {
        await enter('busy');
        void acquireDocLock(docId, 'wait').then((l) => onHeld(l, true));
    }

    return {
        user,
        docId,
        placement,
        durability,
        token,
        lock: () => lock,
        state: () => state,
        generation: () => generation,
        recovery: () => (recovery == null ? null : withoutSnapshot(recovery)),
        autosave: () => autosave,
        reloads: () => reloads,
        capture: async (o = {}) => {
            if (o.bypassLockCheck !== true && !canWrite()) throw new Error(`没有文档的锁（${state}），不写发件箱`);
            return pipeline.capture(editor(), target(o.docId), { durability: o.durability ?? durability, force: o.force, fenceToken: o.docId == null || o.docId === docId ? token : undefined, extra });
        },
        restore: async () => {
            if (recovery?.snapshot == null || recovery.status !== 'restorable') throw new Error(`不能恢复：${recovery?.status ?? 'none'}`);
            autosave?.stop();
            const pendingFormula = recovery.record!.formulaPending === true;
            await reopen(recovery.snapshot, { forceCalc: pendingFormula });
            revision = recovery.record!.baseRevision;
            await pipeline.continueFrom(docId, recovery.record!.localSeq, pendingFormula ? undefined : recovery.record!.contentHash);
            // 带"公式待更新"的快照：打开时强制全量重算，等结果收齐（生产上显示"正在重算"），再补捕获一次，写入不带标记的记录
            if (pendingFormula) await waitForCapture(editor(), { debounceMs: 0, timeoutMs: 120_000 });
            await enter('editing');
            start();
            if (pendingFormula) autosave!.requestFormulaRecapture();
        },
        discard: async () => {
            if (recovery?.record != null) await deleteUpTo(db, user, docId, recovery.record.localSeq, { fenceToken: token, contentHash: recovery.record.contentHash });
            await enter('editing');
            start();
        },
        steal: async () => {
            await onHeld(await acquireDocLock(docId, 'steal'), true);
        },
        inspect: async (id = docId) => withoutSnapshot(await inspectRecovery(db, user, id, key)),
        dispose: () => {
            autosave?.stop();
            pipeline.dispose();
            lock.release();
            db.close();
        },
    };
}
