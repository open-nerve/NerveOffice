# UR-002 等待公式计算完成的接口不覆盖排队的下一轮

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P3 报告 §3.2"计算进行中再改一次"、§3.3 第 4 条、§3.4（`docs/v0.1/M0-技术验证/reports/P3-验证报告.md`）；用例 `spikes/m0/e2e/v07-formula.spec.ts`（`QUEUED_CASES`），结果 `spikes/m0/e2e/results/v07/edit-during-calc/`；P3 交接单"已知的坑"与"上游报告"｜发现版本：1.0.0｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/engine-formula@1.0.1` `lib/es/index.js` 第 43675–43772 行（触发服务：计算进行中的修改只排队，完成通知之后再等 10 ms 才开始新的一轮）与第 15312–15402 行（`waitForLatestApplied` 只等调用时的那一轮），与 1.0.0 源码相同（另见 M1-P4 设计 §3.9：1.0.1 的产物与 1.0.0 相同）；2026-09-28 用 1.0.1 发布包在 Node.js 上直接复现（下文的脚本与输出）；GitHub 上 `dev` 分支（2026-09-28）也没有改

## 摘要（中文）

SDK 不把新的修改并进正在进行的一轮计算：与正在计算的范围不相交就排队，相交就先发 stop（但计算只在让出点检查 stop，常常照样算完）；这一轮的完成通知处理完、再过 10 ms 防抖，才开始新的一轮。`onCalculationResultApplied()` 只等"调用时正在进行的那一轮"：如果调用之前的修改还在排队，它在这一轮结束（或被 stop）时就返回，这时排队的一轮还没开始，依赖最后一次修改的公式仍是旧值；走 stop 的时候，它甚至在没有任何新结果的情况下就返回。计算期间主线程空闲时都会遇到：公式 Worker 模式、主线程模式调小 `intervalCount`、打开之后首次计算还没算完用户就改了单元格。M0-P3 用"等待接口 + 1 秒静默 + 只看最近一轮是否逐表收齐"的旧规则，在 Chromium 与 Chrome 上捕获到 204/406（Worker，两次修改相交走 stop）和 201/406（主线程，让出间隔 20）个过期值；2026-09-28 用 1.0.1 在 Node.js 上直接复现：接口返回时 `Chain!B1` 仍是 2（应为 42），排队的一轮在返回之后 17 ms 才开始。过期值一旦被保存，公式写回不会触发补存，默认的打开方式也不重算。平台的规避同 UR-001：不用这个接口，按状态判断收齐，其中"没有排队的一轮"按 SDK 触发服务的同一口径自己判断（`IActiveDirtyManagerService` 的脏区转换，`apps/web/src/editor/change-tracking/formula-settle-tracker.ts`）。

## 已有的上游讨论

没有找到针对这个缺陷的 issue 或 PR（2026-09-28 检索）。检索用的关键词：`onCalculationResultApplied`、`waitForLatestApplied`、`formula calculation stop pending`、`formula calculation queued`、`calculation end worker is:issue`、`is:pr is:open formula`（GitHub 搜索接口）。

相关的历史：[#7284](https://github.com/dream-num/univer/pull/7284) fix(formula): preserve dirty data across restarts —— 已合并（2026-07-17），引入了"正在计算的与排队的脏区分开、10 ms 防抖、只在相交时 stop"的排队语义，但没有改等待接口（它取代的 [#7281](https://github.com/dream-num/univer/pull/7281) 已关闭）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] `onCalculationResultApplied()` resolves when the in-flight calculation ends, before the recalculation already queued by earlier edits has started

### Describe the bug

`FormulaCalculationTriggerService` does not merge an edit made while a calculation round is running into that round. An edit whose dirty range does not intersect the running round is queued; an intersecting edit triggers a stop request, but the engine only checks for a stop at its yield points (every `intervalCount` formulas), so the running round often completes anyway. In both cases the queued round starts only after the running round's completion notification has been handled, plus a 10 ms debounce.

`onCalculationResultApplied()` is documented as "Waits until the latest formula-calculation results have been applied", but it only waits for the session that exists when it is called. If it is called after such an edit, it resolves as soon as the in-flight session is applied (or stopped) — before the queued round has even started. Formulas that depend on the later edit still have their old values at that point; in the stop case the promise resolves without any new result at all.

This happens whenever the main thread is free while a calculation is running and another edit comes in: formulas calculated in a Web Worker, main-thread mode with a small `intervalCount`, or an edit made while the initial calculation after loading is still running. (With the default `intervalCount` of 500 in main-thread mode, a calculation of fewer than 500 formulas runs as one blocking task, so a second edit can only run after it and the problem does not show up; by code reading, larger calculations yield every 500 formulas and can be affected as well.)

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的仓库或 StackBlitz（Node 模板）链接；下面的脚本已经在本地用 1.0.1 跑过】

Minimal example with public APIs only (Node.js; the same calls work in a browser with the same plugins). `intervalCount: 20` lets the second edit run while the first round is still being calculated.

```js
// node repro.cjs [disjoint|overlap]
const { LocaleType, LogLevel, Univer, UniverInstanceType } = require('@univerjs/core');
const { FUniver } = require('@univerjs/core/facade');
const { UniverSheetsPlugin } = require('@univerjs/sheets');
const { UniverFormulaEnginePlugin } = require('@univerjs/engine-formula');
const { UniverSheetsFormulaPlugin } = require('@univerjs/sheets-formula');
require('@univerjs/sheets/facade');
require('@univerjs/engine-formula/facade');
require('@univerjs/sheets-formula/facade');

const agg = {};
for (let i = 0; i < 20000; i++) agg[i] = { 1: { v: (i * 37) % 1001 } };
const slow = {};
for (let i = 0; i < 200; i++) slow[i] = { 0: { f: `=SUMPRODUCT((Agg!$B$1:$B$20000>${i * 5})*Agg!$B$1:$B$20000)` } };

async function main() {
    const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} }, logLevel: LogLevel.WARN });
    univer.registerPlugin(UniverSheetsPlugin);
    // A small intervalCount lets the second edit run while the first round is still calculating.
    univer.registerPlugin(UniverFormulaEnginePlugin, { intervalCount: 20 });
    univer.registerPlugin(UniverSheetsFormulaPlugin);
    univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
        id: 'wb',
        sheetOrder: ['agg', 'slow', 'chain'],
        sheets: {
            agg: { id: 'agg', name: 'Agg', rowCount: 20100, columnCount: 5, cellData: agg },
            slow: { id: 'slow', name: 'Slow', rowCount: 220, columnCount: 5, cellData: slow },
            chain: { id: 'chain', name: 'Chain', rowCount: 20, columnCount: 5, cellData: { 0: { 0: { v: 1 }, 1: { f: '=A1*2' } } } },
        },
    });
    const univerAPI = FUniver.newAPI(univer);
    const formula = univerAPI.getFormula();
    const wb = univerAPI.getActiveWorkbook();
    await formula.onCalculationResultApplied(120000);

    const t0 = performance.now();
    const lines = [];
    const log = (msg) => lines.push(`${String(Math.round(performance.now() - t0)).padEnd(5)}${msg}`);
    univerAPI.addEvent(univerAPI.Event.CommandExecuted, (e) => {
        if (e.id === 'formula.mutation.set-formula-calculation-start') log('start');
        if (e.id === 'formula.mutation.set-formula-calculation-stop') log('stop');
        if (e.id === 'formula.mutation.set-formula-calculation-result') log('result');
        if (e.id === 'formula.mutation.set-formula-calculation-notification' && e.params.functionsExecutedState !== undefined) {
            log(`completed, functionsExecutedState = ${e.params.functionsExecutedState}`);
        }
    });
    const chainB1 = () => wb.getSheetByName('Chain').getRange('B1').getValue();
    const slowA1 = () => wb.getSheetByName('Slow').getRange('A1').getValue();

    wb.getSheetByName('Agg').getRange('B1').setValue(88888);
    log('edit 1: Agg!B1 = 88888');
    await new Promise((r) => setTimeout(r, 300));
    if (process.argv[2] === 'overlap') {
        wb.getSheetByName('Agg').getRange('B1').setValue(55555);
        log('edit 2: Agg!B1 = 55555');
    } else {
        wb.getSheetByName('Chain').getRange('A1').setValue(21);
        log('edit 2: Chain!A1 = 21');
    }
    await formula.onCalculationResultApplied(120000);
    log(`onCalculationResultApplied() resolved: Chain!B1 = ${chainB1()}, Slow!A1 = ${slowA1()}`);
    await new Promise((r) => setTimeout(r, 6000));
    log(`6 s later: Chain!B1 = ${chainB1()}, Slow!A1 = ${slowA1()}`);
    console.log(lines.join('\n'));
    univer.dispose();
}

main();
```

Steps performed by the script:

1. Workbook with `Agg!B1:B20000` (numbers), `Slow!A1:A200` (200 `SUMPRODUCT`s over `Agg!B1:B20000`), `Chain!A1 = 1` and `Chain!B1 = A1*2`.
2. Edit `Agg!B1`; this starts a long calculation round.
3. 300 ms later, while that round is still running, edit `Chain!A1` (`disjoint`) or `Agg!B1` again (`overlap`, which requests a stop).
4. Right after the second edit, `await univerAPI.getFormula().onCalculationResultApplied()` and read `Chain!B1` and `Slow!A1`.

### Expected behavior

The promise resolves only after the results reflecting every edit made before the call have been applied: `Chain!B1` is 42 in the `disjoint` case, and `Slow!A1` is computed from the second value of `Agg!B1` in the `overlap` case.

### Actual behavior

Output of the script above (Node.js 24.21.0, published 1.0.1 packages; milliseconds after the first edit; `functionsExecutedState` 3 = `SUCCESS`, 1 = `STOP_EXECUTION`):

`node repro.cjs disjoint`

```text
1    edit 1: Agg!B1 = 88888
21   start
510  edit 2: Chain!A1 = 21
2363 result
2363 completed, functionsExecutedState = 3
2363 onCalculationResultApplied() resolved: Chain!B1 = 2, Slow!A1 = 10086638
2380 start
2383 result
2383 completed, functionsExecutedState = 3
8364 6 s later: Chain!B1 = 42, Slow!A1 = 10086638
```

The promise resolves at the end of the first round with `Chain!B1 = 2`; the round containing the second edit starts 17 ms later.

`node repro.cjs overlap`

```text
2    edit 1: Agg!B1 = 88888
20   start
504  edit 2: Agg!B1 = 55555
736  stop
736  completed, functionsExecutedState = 1
738  onCalculationResultApplied() resolved: Chain!B1 = 2, Slow!A1 = 9997750
754  start
3079 result
3079 completed, functionsExecutedState = 3
6740 6 s later: Chain!B1 = 2, Slow!A1 = 10053305
```

The promise resolves right after the stopped round, with `Slow!A1` still at the value from before both edits; the recalculation starts 16 ms later.

We first saw this in browsers through a save-timing rule built on this API: `await onCalculationResultApplied()`, then wait until one second has passed since the last edit, then wait until every worksheet of the latest result has been written back (a stopped round counts as settled), then `save()`. Starting that wait after the second edit and checking all 406 formulas of our test workbook in the saved snapshot:

- formulas in a Web Worker, both edits on the same cell (a stop was requested but the running round finished anyway): 204/406 stale values in the saved snapshot (Chromium 153.0.8010.12 and Chrome 153.0.8010.53);
- main-thread mode with `intervalCount: 20`, second edit on another sheet: 201/406 stale values (same browsers).

The model became correct once the queued round had finished (0/406). In WebKit 26.6 the slow round finished in under a second, so the one-second wait happened to cover the queued round as well and nothing stale was saved.

### Root cause analysis

Paths are relative to the repository root; line numbers refer to tag v1.0.0.

- `packages/engine-formula/src/services/formula-calculation-trigger.service.ts`
  - L33-34, L79-101, L113-120: commands with dirty data are collected and flushed after a 10 ms debounce;
  - L122-145 `_flush()`: while `_executionInProgress` is set, new dirty data only goes into `_pendingDirtyData` (plus a stop request when it intersects the running dirty data), and no new round is started;
  - L160-188 `_handleCalculationNotification()`: only after the completion notification of the running round is `_scheduleFlush()` called again, so the queued round starts at least 10 ms after the running round has finished;
  - none of this pending state (`_waitingCommandQueue`, `_hasPendingCalculation`, `_timer`) is visible to the session service.
- `packages/engine-formula/src/services/formula/formula-calculation-session.service.ts`
  - L202-206: `waitForLatestApplied()` takes the state at call time; if a session is running, it waits for that session (`waitForExistingSession`);
  - L251-277: it resolves in a microtask once that session reaches an applied terminal state, or through `setTimeout(0)` when the session was stopped without a result (L267-274). Both happen before the 10 ms debounce that starts the queued round.
- `packages/engine-formula/src/services/calculate-formula.service.ts` L295 and L328-335: the engine yields, and can observe a stop, only every `intervalCount` formulas (default 500), so an intersecting edit often does not stop the running round.
- `packages/engine-formula/src/facade/f-formula.ts` L229-236: the documented contract of `onCalculationResultApplied()`.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. Affected package: `@univerjs/engine-formula`. The code is unchanged on `dev` (checked on 2026-09-28).
- Browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, Google Chrome 153.0.8010.53; all headless, driven by Playwright. Also reproduced without a browser: Node.js 24.21.0.
- OS: macOS 26.5.1 (Apple M4 Pro) for the browser runs; macOS 27.0 (arm64) for the Node.js run.

### Suggested fix

- Let the wait take the trigger service's pending work into account: for example, expose whether a calculation is pending (queued commands, pending dirty data or a scheduled flush) from `FormulaCalculationTriggerService`, and in `waitForLatestApplied()` keep waiting for the next session, instead of resolving, when the current session is applied or stopped while a calculation is still pending.
- Or use generations: increment a "requested" counter whenever the trigger service accepts dirty data, record in each started session the counter value it covers, and resolve only once an applied session covers the value seen at call time.
