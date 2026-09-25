// 本机发件箱原型（P6）：把密钥、锁、恢复、写入管道与自动保存装到一份打开的文档上。只用于验证，M4 按正式流程重写。
// 流程（00 号计划书 §7.5）：取密钥 → 申请文档的锁 → 拿到锁：检查发件箱里有没有这份文档的未同步记录 →
// 没有就开始自动保存；有就等用户选择"恢复"或"放弃"；拿不到锁：另一个标签页正在编辑，不写发件箱，
// 并排队等锁（对方关闭或崩溃后接手，再走上面的检查）。
import type { EditorHandle } from '../create-editor';
import type { AutosaveHandle } from './autosave';
import type { Placement, PipelineResult } from './pipeline';
import type { RecoveryInfo, RecoveryResult } from './recovery';
import type { Durability } from './store';
import type { TabLock } from './tab-lock';

import { startAutosave } from './autosave';
import { fetchUserKey } from './crypto';
import { createPipeline } from './pipeline';
import { inspectRecovery } from './recovery';
import { deleteUpTo, openOutbox } from './store';
import { acquireDocLock } from './tab-lock';

export type OutboxState = 'editing' | 'busy' | 'lost' | 'recovery-pending';

export interface OutboxHandle {
    user: string;
    docId: string;
    placement: Placement;
    durability: Durability;
    lock(): TabLock;
    state(): OutboxState;
    /** 打开时检查到的未同步记录（不含快照内容）。 */
    recovery(): RecoveryInfo | null;
    autosave(): AutosaveHandle | null;
    /** 手动捕获并写入（测量与填充配额用）；docId 可以换成别的键。 */
    capture(options?: { force?: boolean; durability?: Durability; docId?: string }): Promise<PipelineResult>;
    /** 用发件箱里的快照重建编辑器，然后开始自动保存。 */
    restore(): Promise<void>;
    /** 放弃本机的未同步修改。 */
    discard(): Promise<void>;
    /** 重新检查发件箱（不改变状态）；docId 缺省为本文档。 */
    inspect(docId?: string): Promise<RecoveryInfo>;
    dispose(): void;
}

export interface InstallOutboxOptions {
    editor: () => EditorHandle;
    /** 用给定的快照重建编辑器（宿主页面实现）。 */
    reopen: (data: Record<string, unknown>) => Promise<EditorHandle>;
    user: string;
    docId: string;
    revision: number;
    placement: Placement;
    durability: Durability;
    /** V15：mutation 日志的当前位置（捕获时与 save() 在同一个同步段里读取）。 */
    logMark?: () => { logId: string; logSeq: number } | null;
}

const withoutSnapshot = (r: RecoveryResult): RecoveryInfo => {
    const { snapshot: _s, ...info } = r;
    return info;
};

export async function installOutbox(options: InstallOutboxOptions): Promise<OutboxHandle> {
    const { editor, reopen, user, docId, placement, durability } = options;
    let revision = options.revision;
    const key = await fetchUserKey(user);
    let lock = await acquireDocLock(docId);
    let state: OutboxState = 'busy';
    const db = await openOutbox();
    const pipeline = await createPipeline(placement, key);
    // target() 与 capture 里的 save() 之间没有 await：日志位置与快照内容一致
    const target = (id = docId) => ({ userId: user, docId: id, baseRevision: revision, writeEpoch: 0, clientBuild: 'm0-p6', ...(options.logMark?.() ?? {}) });
    let autosave: AutosaveHandle | null = null;
    let recovery: RecoveryResult | null = null;

    const start = () => {
        autosave?.stop();
        autosave = startAutosave(editor(), () => pipeline.capture(editor(), target(), { durability }));
    };

    /** 拿到锁之后：检查发件箱，没有未同步记录就开始自动保存。 */
    const onHeld = async (held: TabLock) => {
        lock = held;
        held.onLost(() => {
            autosave?.stop();
            state = 'lost';
        });
        recovery = await inspectRecovery(db, user, docId, key);
        if (recovery.record != null) await pipeline.setSeq(docId, recovery.record.localSeq);
        if (recovery.status === 'none') {
            state = 'editing';
            start();
        } else state = 'recovery-pending';
    };
    if (lock.state() === 'held') await onHeld(lock);
    else void acquireDocLock(docId, 'wait').then(onHeld);

    return {
        user,
        docId,
        placement,
        durability,
        lock: () => lock,
        state: () => state,
        recovery: () => (recovery == null ? null : withoutSnapshot(recovery)),
        autosave: () => autosave,
        capture: async (o = {}) => {
            if (state === 'busy' || state === 'lost') throw new Error(`没有文档的锁（${state}），不写发件箱`);
            return pipeline.capture(editor(), target(o.docId), { durability: o.durability ?? durability, force: o.force });
        },
        restore: async () => {
            if (recovery?.snapshot == null || recovery.status !== 'restorable') throw new Error(`不能恢复：${recovery?.status ?? 'none'}`);
            autosave?.stop();
            await reopen(recovery.snapshot);
            revision = recovery.record!.baseRevision;
            await pipeline.setSeq(docId, recovery.record!.localSeq, recovery.record!.contentHash);
            state = 'editing';
            start();
        },
        discard: async () => {
            if (recovery?.record != null) await deleteUpTo(db, user, docId, recovery.record.localSeq);
            state = 'editing';
            start();
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
