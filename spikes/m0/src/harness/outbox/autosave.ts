// 自动保存到本机（P6，00 号计划书 §7.2）：检测到修改后，按捕获时机（P3 报告 §3.4、P5 的组合输入感知）捕获并写入发件箱。
// - 修改停止 1 秒后捕获；持续编辑时，从第一处未保存的修改算起最长 3 秒捕获一次（waitForCapture 的时限）；
// - 内容与上次写入的相同时跳过（写入段里的去重哈希）；
// - 记录"最后一次修改 → 已保存在本机"（端到端，V14-2）。
import type { EditorHandle } from '../create-editor';
import type { PipelineResult } from './pipeline';

import { waitForCapture } from '../capture-timing';

export type AutosaveStatus = 'idle' | 'waiting' | 'saving' | 'saved-local' | 'error' | 'stopped';

export interface AutosaveEntry {
    /** 这次捕获覆盖到的最后一次修改（performance.now()）。 */
    editAt: number;
    /** 第一处未保存的修改被发现的时刻。 */
    firstPendingAt: number;
    storedAt: number;
    /** 最后一次修改 → 已保存在本机（毫秒）。 */
    e2eMs: number;
    /** 等待捕获的原因：quiet（停顿满 1 秒）或 cap（持续编辑满 3 秒）。 */
    trigger: 'quiet' | 'cap';
    result: PipelineResult;
}

export interface AutosaveHandle {
    status(): AutosaveStatus;
    history: AutosaveEntry[];
    lastError(): string | null;
    /** 等到当前没有待保存的修改（或出错）为止。 */
    idle(timeoutMs?: number): Promise<AutosaveStatus>;
    stop(): void;
}

export interface AutosaveOptions {
    debounceMs?: number;
    maxIntervalMs?: number;
}

export function startAutosave(editor: EditorHandle, capture: () => Promise<PipelineResult>, options: AutosaveOptions = {}): AutosaveHandle {
    const debounceMs = options.debounceMs ?? 1000;
    const maxIntervalMs = options.maxIntervalMs ?? 3000;
    const history: AutosaveEntry[] = [];
    let status: AutosaveStatus = 'idle';
    let error: string | null = null;
    let handledUpTo = editor.detector.lastDetectionAt() ?? 0;
    let busy = false;
    let stopped = false;
    let retryAfter = 0;

    const pending = () => (editor.detector.lastDetectionAt() ?? 0) > handledUpTo;

    const run = async () => {
        busy = true;
        const firstPendingAt = performance.now();
        try {
            status = 'waiting';
            const timeoutMs = Math.max(0, firstPendingAt + maxIntervalMs - performance.now());
            const wait = await waitForCapture(editor, { debounceMs, timeoutMs });
            const editAt = editor.detector.lastDetectionAt() ?? firstPendingAt;
            status = 'saving';
            const result = await capture();
            if (result.error != null) throw new Error(result.error);
            handledUpTo = editAt;
            history.push({ editAt, firstPendingAt, storedAt: result.finishedAt, e2eMs: result.finishedAt - editAt, trigger: wait.waitedMs >= timeoutMs - 5 ? 'cap' : 'quiet', result });
            status = pending() ? 'waiting' : 'saved-local';
            error = null;
        } catch (e) {
            status = 'error';
            error = e instanceof Error ? e.message : String(e);
            retryAfter = performance.now() + 1000;
        } finally {
            busy = false;
        }
    };

    const timer = setInterval(() => {
        if (stopped || busy || performance.now() < retryAfter) return;
        if (pending()) void run();
    }, 50);

    return {
        status: () => status,
        history,
        lastError: () => error,
        async idle(timeoutMs = 15_000) {
            const deadline = performance.now() + timeoutMs;
            while (performance.now() < deadline && (busy || pending()) && status !== 'error') await new Promise((r) => setTimeout(r, 50));
            return status;
        },
        stop() {
            stopped = true;
            status = 'stopped';
            clearInterval(timer);
        },
    };
}
