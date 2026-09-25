// 自动保存到本机（P6，00 号计划书 §7.2）：检测到修改后，按捕获时机（P3 报告 §3.4、P5 的组合输入感知）捕获并写入发件箱。
// - 修改停止 1 秒后捕获；持续编辑时，从第一处未保存的修改算起最长 3 秒捕获一次（waitForCapture 的时限）；
// - 3 秒的上限会截断公式等待：这时照常捕获，记录标上"公式待更新"，公式收齐之后再补捕获一次（P3 §3.4 第 3 条，P6 审查 R3）；
// - 每次捕获之前核对 canWrite（持有文档的锁、处于编辑状态）；失去锁后立即停止（P6 审查 R1，存储层另有写入栅栏）；
// - 内容与上次写入的相同时跳过（写入段里的去重哈希）；
// - 记录"最后一次修改 → 已保存在本机"（端到端，V14-2）。
import type { EditorHandle } from '../create-editor';
import type { PipelineResult } from './pipeline';

import { formulaPending, waitForCapture } from '../capture-timing';

export type AutosaveStatus = 'idle' | 'waiting' | 'saving' | 'saved-local' | 'formula-pending' | 'error' | 'stopped';

export interface AutosaveEntry {
    /** 这次捕获覆盖到的最后一次修改（performance.now()）。 */
    editAt: number;
    /** 第一处未保存的修改被发现的时刻。 */
    firstPendingAt: number;
    storedAt: number;
    /** 最后一次修改 → 已保存在本机（毫秒）。 */
    e2eMs: number;
    /** 触发捕获的原因：quiet（停顿满 1 秒）、cap（持续编辑满 3 秒）、formula（公式收齐后的补捕获）。 */
    trigger: 'quiet' | 'cap' | 'formula';
    formulaPending: boolean;
    result: PipelineResult;
}

export interface AutosaveHandle {
    status(): AutosaveStatus;
    history: AutosaveEntry[];
    lastError(): string | null;
    /** 等到当前没有待保存的修改、也没有待补的公式捕获（或出错、停止）为止。 */
    idle(timeoutMs?: number): Promise<AutosaveStatus>;
    /** 要求在公式收齐后补捕获一次（恢复了带"公式待更新"的快照时用）。 */
    requestFormulaRecapture(): void;
    stop(): void;
}

export interface AutosaveOptions {
    debounceMs?: number;
    maxIntervalMs?: number;
    /** 捕获之前核对：还持有文档的锁、处于编辑状态。 */
    canWrite?: () => boolean;
}

/** capture(formulaPending, force)：force 用于公式收齐后的补捕获——内容可能与上次相同，但要写入一条不带"公式待更新"标记的记录。 */
export function startAutosave(editor: EditorHandle, capture: (formulaPending: boolean, force: boolean) => Promise<PipelineResult>, options: AutosaveOptions = {}): AutosaveHandle {
    const debounceMs = options.debounceMs ?? 1000;
    const maxIntervalMs = options.maxIntervalMs ?? 3000;
    const canWrite = options.canWrite ?? (() => true);
    const history: AutosaveEntry[] = [];
    let status: AutosaveStatus = 'idle';
    let error: string | null = null;
    let handledUpTo = editor.detector.lastDetectionAt() ?? 0;
    let busy = false;
    let stopped = false;
    let retryAfter = 0;
    let recaptureAfterFormula = false;

    const pending = () => (editor.detector.lastDetectionAt() ?? 0) > handledUpTo;
    const stop = () => {
        stopped = true;
        status = 'stopped';
        clearInterval(timer);
    };

    const store = async (trigger: AutosaveEntry['trigger'], firstPendingAt: number, formula: boolean, editAt: number) => {
        if (stopped || !canWrite()) {
            stop();
            return;
        }
        status = 'saving';
        const result = await capture(formula, trigger === 'formula');
        if (result.error != null) throw new Error(result.error);
        if (stopped) return;
        handledUpTo = Math.max(handledUpTo, editAt);
        recaptureAfterFormula = formula;
        history.push({ editAt, firstPendingAt, storedAt: result.finishedAt, e2eMs: result.finishedAt - editAt, trigger, formulaPending: formula, result });
        status = pending() ? 'waiting' : formula ? 'formula-pending' : 'saved-local';
        error = null;
    };

    const run = async () => {
        busy = true;
        const firstPendingAt = performance.now();
        try {
            status = 'waiting';
            const timeoutMs = Math.max(0, firstPendingAt + maxIntervalMs - performance.now());
            const wait = await waitForCapture(editor, { debounceMs, timeoutMs });
            if (stopped) return;
            const editAt = editor.detector.lastDetectionAt() ?? firstPendingAt;
            await store(wait.waitedMs >= timeoutMs - 5 ? 'cap' : 'quiet', firstPendingAt, wait.formula === 'pending', editAt);
        } catch (e) {
            if (stopped) return;
            status = 'error';
            error = e instanceof Error ? e.message : String(e);
            retryAfter = performance.now() + 1000;
        } finally {
            busy = false;
        }
    };

    /** 上一次捕获时公式没收齐：收齐之后（且没有新的修改在等）补捕获一次，内容与公式结果一致。 */
    const recapture = async () => {
        busy = true;
        try {
            await store('formula', performance.now(), false, handledUpTo);
        } catch (e) {
            if (stopped) return;
            status = 'error';
            error = e instanceof Error ? e.message : String(e);
            retryAfter = performance.now() + 1000;
        } finally {
            busy = false;
        }
    };

    const timer = setInterval(() => {
        if (stopped || busy || performance.now() < retryAfter) return;
        if (!canWrite()) {
            stop();
            return;
        }
        if (pending()) void run();
        else if (recaptureAfterFormula && !formulaPending(editor)) void recapture();
    }, 50);

    return {
        status: () => status,
        history,
        lastError: () => error,
        async idle(timeoutMs = 15_000) {
            const deadline = performance.now() + timeoutMs;
            while (performance.now() < deadline && (busy || pending() || recaptureAfterFormula) && status !== 'error' && !stopped) await new Promise((r) => setTimeout(r, 50));
            return status;
        },
        requestFormulaRecapture() {
            recaptureAfterFormula = true;
        },
        stop,
    };
}
