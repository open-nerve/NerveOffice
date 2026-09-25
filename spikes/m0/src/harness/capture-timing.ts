// 捕获时机（V07，P3 报告 §3.4 的规则，审查后修订）：
//   1. 用户修改被检测到后进入"待捕获"；公式结果写回本身不进入待捕获（否则打开含易变函数的文档就会被当成有修改）。
//   2. 待捕获时循环：
//      a. 记下最后一次修改的时刻，发起一次 onCalculationResultApplied（在最后一次修改之后发起）；
//      b. 等到距最后一次修改满 1 秒（管道的防抖）；
//      c. 等公式计算收齐：
//         - 最近一轮 start 之后没有再执行会触发计算的命令（否则新的一轮还在排队：SDK 不把新修改并进正在进行的一轮，
//           要等这一轮的完成通知之后再过 10 ms 才开始；判断口径与 SDK 的触发服务一致，见 change-detector.ts）；
//         - 这一轮没有被 stop（被 stop 的一轮会带着没算完的部分重新开始）；
//         - 结果 mutation 中带结果的每张工作表都收到了写回（Worker 模式下等待接口在第一张表写回后就返回）；
//           这一轮没有结果 mutation、只收到"计算完成"通知时（修改没有牵动公式），视为收齐；
//      d. 等待期间又检测到修改，就从 a 重来；否则捕获。
//   3. 超过总时限仍未收齐：照常捕获并标记"公式待更新"，由调用方在收齐后补捕获。
// 捕获时刻 ≈ max（最后一次修改 + 1 秒，最后一次修改所触发的那一轮公式结果收齐）。
// P5 补充（组合输入）：输入法组合进行中不捕获（中间文字是拼音）；防抖从"最后一次修改"与"最后一次组合结束"中较晚的一个算起
// （Chrome 的提交路径在 compositionend 时不产生 mutation，只等 mutation 会漏掉）。respectComposition: false 时是 P3 的原规则。
// 组合持续超过 compositionMaxWaitMs（默认 3 秒，与 00 号计划书 §7.2"持续编辑时最长每 3 秒捕获一次"一致）就照常捕获：
// 快照里的拼音会被提交后的下一次捕获覆盖，但组合开始之前的修改不会一直写不进本机（P5 审查 G4）。
import type { EditorHandle } from './create-editor';

export interface CaptureWait {
    /** 从开始等待到可以捕获的耗时。 */
    waitedMs: number;
    /** settled：公式结果已收齐（或没有计算）；pending：超时仍未收齐，捕获要标记"公式待更新"；n/a：文字文档。 */
    formula: 'settled' | 'pending' | 'n/a';
    /** 等待期间又检测到修改、从头再等的次数。 */
    restarts: number;
    /** 超时时组合输入仍在进行（P5）。 */
    composing: boolean;
}

export interface CaptureWaitOptions {
    debounceMs?: number;
    timeoutMs?: number;
    /** 组合输入进行中不捕获（P5，默认 true）。 */
    respectComposition?: boolean;
    /** 组合持续超过这个时长（毫秒，从组合开始算）就照常捕获（默认 3000）。 */
    compositionMaxWaitMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 公式计算是否还没收齐（只看仍然存在的工作表：写回控制器会跳过已删除的工作表）。 */
export function formulaPending(editor: EditorHandle): boolean {
    if (editor.kind !== 'sheet') return false;
    const p = editor.detector.formulaProgress();
    // 最近一轮开始之后又有会触发计算的修改：新的一轮还在排队
    if (p.queued) return true;
    if (!p.started) return false;
    // 被 stop 的一轮：SDK 会把它没算完的部分并进下一轮重新开始
    if (p.stopped) return true;
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
    const respect = options.respectComposition ?? true;
    const compositionMaxWaitMs = options.compositionMaxWaitMs ?? 3000;
    const t0 = performance.now();
    const deadline = t0 + timeoutMs;
    const left = () => Math.max(0, deadline - performance.now());
    const composition = () => editor.detector.composition();
    /** 组合进行中，且没有超过上限。 */
    const holding = () => {
        const c = composition();
        return respect && c.active && performance.now() - (c.lastStartAt ?? 0) < compositionMaxWaitMs;
    };
    const quietSince = () => Math.max(editor.detector.lastDetectionAt() ?? t0, respect ? composition().lastEndAt ?? 0 : 0);
    let restarts = 0;

    for (;;) {
        const lastEdit = editor.detector.lastDetectionAt();
        const lastComposition = composition().count;
        if (editor.kind === 'sheet') {
            try {
                await editor.univerAPI.getFormula().onCalculationResultApplied(Math.max(1, left()));
            } catch {
                // 超时：继续按下面的逐表判断，最后标记"公式待更新"
            }
        }
        while (holding() && left() > 0) await sleep(20);
        while (performance.now() - quietSince() < debounceMs && left() > 0) await sleep(20);
        while (formulaPending(editor) && left() > 0) await sleep(20);
        const compositionChanged = respect && (holding() || composition().count !== lastComposition);
        if ((editor.detector.lastDetectionAt() !== lastEdit || compositionChanged) && left() > 0) {
            restarts += 1;
            continue;
        }
        break;
    }
    return {
        waitedMs: performance.now() - t0,
        formula: editor.kind !== 'sheet' ? 'n/a' : formulaPending(editor) ? 'pending' : 'settled',
        restarts,
        composing: composition().active,
    };
}
