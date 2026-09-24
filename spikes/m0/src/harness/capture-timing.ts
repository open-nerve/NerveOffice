// 捕获时机（V07，P3 报告 §3.4 的规则，审查后修订）：
//   1. 用户修改被检测到后进入"待捕获"；公式结果写回本身不进入待捕获（否则打开含易变函数的文档就会被当成有修改）。
//   2. 待捕获时循环：
//      a. 记下最后一次修改的时刻，发起一次 onCalculationResultApplied（在最后一次修改之后发起）；
//      b. 等到距最后一次修改满 1 秒（管道的防抖）；
//      c. 等最近一轮公式计算"逐表收齐"：结果 mutation 中带结果的每张工作表都收到了写回（Worker 模式下等待接口在第一张表写回后就返回）；
//         这一轮没有结果 mutation、只收到"计算完成"通知时（修改没有牵动公式），视为收齐；
//      d. 等待期间又检测到修改，就从 a 重来；否则捕获。
//   3. 超过总时限仍未收齐：照常捕获并标记"公式待更新"，由调用方在收齐后补捕获。
// 捕获时刻 ≈ max（最后一次修改 + 1 秒，这一轮公式结果收齐）。
import type { EditorHandle } from './create-editor';

export interface CaptureWait {
    /** 从开始等待到可以捕获的耗时。 */
    waitedMs: number;
    /** settled：公式结果已收齐（或没有计算）；pending：超时仍未收齐，捕获要标记"公式待更新"；n/a：文字文档。 */
    formula: 'settled' | 'pending' | 'n/a';
    /** 等待期间又检测到修改、从头再等的次数。 */
    restarts: number;
}

export interface CaptureWaitOptions {
    debounceMs?: number;
    timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 最近一轮公式计算是否还没收齐（只看仍然存在的工作表：写回控制器会跳过已删除的工作表）。 */
export function formulaPending(editor: EditorHandle): boolean {
    if (editor.kind !== 'sheet') return false;
    const p = editor.detector.formulaProgress();
    if (!p.started || p.stopped) return false;
    // 还没有结果：计算结束（completed）说明这一轮没有需要写回的结果；否则仍在计算
    if (p.resultSheets == null) return !p.completed;
    const wb = editor.univerAPI.getActiveWorkbook();
    if (wb == null) return false;
    return p.resultSheets.some((key) => {
        const [unitId, sheetId] = key.split('/');
        return unitId === wb.getId() && wb.getSheetBySheetId(sheetId) != null && !p.appliedSheets.includes(key);
    });
}

export async function waitForCapture(editor: EditorHandle, options: CaptureWaitOptions = {}): Promise<CaptureWait> {
    const debounceMs = options.debounceMs ?? 1000;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const t0 = performance.now();
    const deadline = t0 + timeoutMs;
    const left = () => Math.max(0, deadline - performance.now());
    let restarts = 0;

    for (;;) {
        const lastEdit = editor.detector.lastDetectionAt();
        if (editor.kind === 'sheet') {
            try {
                await editor.univerAPI.getFormula().onCalculationResultApplied(Math.max(1, left()));
            } catch {
                // 超时：继续按下面的逐表判断，最后标记"公式待更新"
            }
        }
        while (performance.now() - (editor.detector.lastDetectionAt() ?? t0) < debounceMs && left() > 0) await sleep(20);
        while (formulaPending(editor) && left() > 0) await sleep(20);
        if (editor.detector.lastDetectionAt() !== lastEdit && left() > 0) {
            restarts += 1;
            continue;
        }
        break;
    }
    return {
        waitedMs: performance.now() - t0,
        formula: editor.kind !== 'sheet' ? 'n/a' : formulaPending(editor) ? 'pending' : 'settled',
        restarts,
    };
}
