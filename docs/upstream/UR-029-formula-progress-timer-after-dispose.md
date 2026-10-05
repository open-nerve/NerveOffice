# UR-029 销毁 Univer 时正在算公式：sheets-formula 的 1 秒进度计时器不清，到点调已销毁的语言服务，抛出没接住的"Locale not initialized"

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue（与 UR-030、UR-031 同属"销毁之后还在跑的异步回调"，是否合并见跟踪表"提交之前要确认的事"）
> 出处：main `f755729` 的修复（M3-P3 合并之后，main `16f8a1d` 的 CI 上容器 E2E 偶发失败：`save.spec.ts`"计算进行中又改了一处"重试才通过，页面里一条没接住的异常"[LocaleService]: Locale not initialized"）；ADR-010"M3-P4 的补充"第 1 条；内部 API 登记 `disposalSafeLocaleOverride`（`apps/web/src/editor/internal-api/registry.ts`，依赖的 SDK 行为与证据）；平台的规避 `apps/web/src/editor/internal-api/locale-service.ts`（`DisposalSafeLocaleService`），回归 E2E `tests/e2e/specs/editor/edit-mode.spec.ts`"阅读时一轮计算刚开始就点'编辑'"（修之前本机三个浏览器各 5 次全部失败）
> 发现版本：1.0.1｜1.0.1 发布包的代码：`@univerjs/sheets-formula@1.0.1` `lib/es/index.js` 的 `TriggerCalculationController`（`_initialExecuteFormulaProcessListener` 里的 1 秒计时器、`dispose`、`_startProgress`）与 `UniverSheetsFormulaPlugin`（按 `isNodeEnv()` 在 `onReady` 或 `onRendered` 创建它），`@univerjs/core@1.0.1` `lib/es/index.js` 的 `LocaleService`（`t` 在语言包为空时抛错，销毁时清空语言包）｜1.0.0 源码：相同（本地参考 `refer/univer` 是 v1.0.0；1.0.2 与 `dev` 没有核对）｜发布包上的复现：2026-10-06 用 1.0.1 发布包在 Node.js 24.21.0 上复现（下文的脚本与输出：开始通知之后 1 秒抛出；不挂 `uncaughtException` 时进程以退出码 1 结束）；同一天在只用 SDK 的最小页面上复现（Playwright 1.63.0 的 Chromium 153.0.8010.12 与 WebKit 26.6，无头：Steady 之后强制重算 1000 个 SUMPRODUCT，第一条进度通知之后销毁实例，开始通知之后 1.0 秒出现页面异常"Locale not initialized"）

## 摘要（中文）

sheets-formula 的 `TriggerCalculationController` 收到一轮计算的开始通知时，设一个 1 秒的计时器（算得超过 1 秒才显示进度条），到点调 `_startProgress()`，里面用语言服务的 `t()` 取"正在分析"的文字。这个计时器只在这一轮的结束通知到来时清掉，`dispose()` 里不清。实例在一轮计算进行中被销毁时，控制器对命令的监听随销毁取消，结束通知再也到不了它，计时器在开始通知之后 1 秒照常到点；而 core 的 `LocaleService` 销毁时清空了语言包，之后 `t()` 一律抛出 `[LocaleService]: Locale not initialized`。于是销毁之后约 1 秒，计时器里抛出一个没有人接住的异常：浏览器里是一条页面异常，Node.js 里没有 `uncaughtException` 处理时进程直接退出。

对平台的影响：阅读与编辑之间的切换一律重建编辑器（M3-P2 设计 §3.1），旧的编辑器在一轮计算的这 1 秒里被销毁、这一轮又还没算完时，就会碰到——打开含公式的表格马上点"编辑"即可复现，CI 的机器慢，正好落进这 1 秒，表现为容器 E2E 偶发失败。只是页面异常，不影响数据。

平台的规避（main `f755729`）：`new Univer({ override })` 把核心注入器里的 `LocaleService` 换成子类 `DisposalSafeLocaleService`，只改销毁之后（含销毁的过程中）的 `t()`：交回键本身、不抛错；销毁之前的行为完全不变。它不依赖计时器的时长、不延迟销毁，同时也盖住了 SDK 里别的、销毁之后才调 `t()` 的异步回调（登记里列了几处，都要用户操作在先，没有逐个复现）。所以上游只修好这个计时器时，这项替换仍留作兜底；上游如果改成销毁之后 `t()` 不抛错，单元测试 `locale-service.test.ts` 里"SDK 的 `LocaleService` 销毁之后仍抛错"那一条会失败，提醒撤掉这项替换。

## 已有的上游讨论

- 没有检索：本次只用本地资源（本地参考源码与 1.0.1 发布包），不访问网络。【待补充：提交之前检索一次，建议的关键词：`Locale not initialized`、`TriggerCalculationController dispose`、`_startProgress`、`startDependencyTimer`、`dispose during calculation`】

---

## Issue（英文，可以直接提交）

**Title:** [Bug] sheets-formula: `TriggerCalculationController` does not clear its 1-second progress timer on dispose — disposing Univer during a formula calculation throws an uncaught `[LocaleService]: Locale not initialized` one second later

### Describe the bug

When `TriggerCalculationController` (`@univerjs/sheets-formula`) receives the start notification of a calculation, it schedules a 1-second timer that shows the progress bar for long calculations (`_startProgress()`, which calls `LocaleService.t()`). The timer is only cleared when the end notification of that calculation arrives. `dispose()` does not clear it.

If the Univer instance is disposed while a calculation is running, the controller's command listener is disposed with it, so the end notification never reaches it, and the timer still fires one second after the start. By then `LocaleService` has been disposed: its `dispose()` sets the language packs to `null`, and `t()` throws `[LocaleService]: Locale not initialized` whenever they are `null`. The result is an uncaught exception thrown from a timer about one second after `univer.dispose()`: a page error in the browser; in Node.js, without an `uncaughtException` handler, the process exits.

This is easy to hit in an app that recreates the Univer instance (e.g. switching between a read-only and an editable instance): open a workbook whose formulas need calculating and recreate the instance right away.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的仓库或 StackBlitz（Node 模板）链接；下面的脚本已经在本地用 1.0.1 跑过】

Node.js (the same happens in the browser, see "Actual behavior"):

```js
// node repro.cjs [during|after]
//   during: dispose the Univer instance while a formula calculation is running
//   after:  dispose it after the calculation has finished (control)
const { LocaleType, LogLevel, Univer, UniverInstanceType } = require('@univerjs/core');
const { FUniver } = require('@univerjs/core/facade');
const { UniverSheetsPlugin } = require('@univerjs/sheets');
const { FormulaExecutedStateType, FormulaExecuteStageType, SetFormulaCalculationNotificationMutation, UniverFormulaEnginePlugin } = require('@univerjs/engine-formula');
const { UniverSheetsFormulaPlugin } = require('@univerjs/sheets-formula');
require('@univerjs/sheets/facade');

const variant = process.argv[2] ?? 'during';
const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)} ms`;
process.on('uncaughtException', (error) => {
    console.log(`${ms()} uncaughtException: ${error.message}`);
    // the first stack frames, without file paths
    console.log(error.stack.split('\n').slice(1, 4).map((line) => line.replace(/\(.*node_modules\/(@univerjs\/[^/]+)\/.*\)/, '($1)')).join('\n'));
});

const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} }, logLevel: LogLevel.ERROR });
univer.registerPlugin(UniverSheetsPlugin);
univer.registerPlugin(UniverFormulaEnginePlugin);
univer.registerPlugin(UniverSheetsFormulaPlugin);
const univerAPI = FUniver.newAPI(univer);

const dispose = (when) => setTimeout(() => {
    univer.dispose();
    console.log(`${ms()} univer.dispose() ${when}`);
}, 0);
univerAPI.addEvent(univerAPI.Event.CommandExecuted, ({ id, params }) => {
    if (id !== SetFormulaCalculationNotificationMutation.id) return;
    if (params.stageInfo?.stage === FormulaExecuteStageType.START) {
        console.log(`${ms()} calculation started`);
        if (variant === 'during') dispose('while the calculation is running');
    } else if (params.stageInfo == null) {
        console.log(`${ms()} calculation finished (${FormulaExecutedStateType[params.functionsExecutedState]})`);
        if (variant === 'after') dispose('after the calculation');
    }
});

// 3,000 formulas without cached values: the initial calculation (CalculationMode.WHEN_EMPTY) takes a while
const cellData = {};
for (let r = 0; r < 300; r++) {
    cellData[r] = { 0: { v: r }, 1: { v: r * 2 } };
    for (let c = 2; c < 12; c++) cellData[r][c] = { f: '=SUMPRODUCT($A$1:$A$300,$B$1:$B$300)+ROW()' };
}
univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
    id: 'wb',
    sheetOrder: ['s1'],
    sheets: { s1: { id: 's1', name: 'Sheet1', rowCount: 300, columnCount: 12, cellData } },
});
setTimeout(() => console.log(`${ms()} end of script`), 3000);
```

In the browser, with the usual sheet UI plugins: wait for the Steady stage, call `univerAPI.getFormula().executeCalculation()` on a sheet with enough formulas (we used 1,000 `SUMPRODUCT` over 1,000 rows), and call `univer.dispose()` while it is running (we did it from a microtask queued on the first progress notification).

### Expected behavior

Disposing the instance cancels everything the controller scheduled; nothing runs, and nothing throws, after `univer.dispose()`.

### Actual behavior

`node repro.cjs during` (1.0.1):

```text
41 ms calculation started
150 ms univer.dispose() while the calculation is running
1046 ms uncaughtException: [LocaleService]: Locale not initialized
    at LocaleService.t (@univerjs/core)
    at TriggerCalculationController._startProgress (@univerjs/sheets-formula)
    at Timeout._onTimeout (@univerjs/sheets-formula)
3022 ms end of script
```

`node repro.cjs after` (control):

```text
42 ms calculation started
186 ms calculation finished (SUCCESS)
195 ms univer.dispose() after the calculation
3022 ms end of script
```

Without the `uncaughtException` handler, `node repro.cjs during` exits with code 1 about one second after the start.

In the browser (minimal page with the SDK only, headless Chromium 153 and WebKit 26.6): the page error `Uncaught Error: [LocaleService]: Locale not initialized` appears 1.0 s after the start notification of the calculation during which the instance was disposed.

### Root cause analysis

Paths are relative to the repository root, at tag v1.0.0 (the same code is in the published 1.0.1 packages).

- `packages/sheets-formula/src/controllers/trigger-calculation.controller.ts`, `TriggerCalculationController`:
  - `_initialExecuteFormulaProcessListener()` keeps the timer in a local variable (`startDependencyTimer`). On `FormulaExecuteStageType.START` it schedules `setTimeout(() => { …; this._startProgress(); }, 1000)`; apart from being replaced when the next calculation starts, it is cleared only in the branch that handles the end notification (`functionsExecutedState`), when no other calculation is pending.
  - `dispose()` disposes the command listeners and completes `progress$`, but cannot reach the timer.
  - `_startProgress()` calls `this._localeService.t('sheets-formula.progress.analyzing')`.
  - In the browser the controller is created at the Rendered stage (`onRendered()` of `UniverSheetsFormulaPlugin`), in Node.js at Ready (`isNodeEnv()`), so both environments are affected.
- `packages/core/src/services/locale/locale.service.ts`, `LocaleService`: the disposable registered in the constructor sets `_locales = null` on dispose, and `t()` throws `[LocaleService]: Locale not initialized` when `_locales` is `null`.
- When the instance is disposed during a calculation, the end notification is not delivered to the disposed listener (in the main-thread set-up the calculation loop even keeps running after disposal, which is a separate issue); either way the timer is never cleared.

### Suggested fix

Clear the timer when the controller is disposed, e.g. in `_initialExecuteFormulaProcessListener()`:

```ts
let startDependencyTimer: ReturnType<typeof setTimeout> | null = null;
this.disposeWithMe(toDisposable(() => {
    if (startDependencyTimer !== null) {
        clearTimeout(startDependencyTimer);
        startDependencyTimer = null;
    }
}));
```

(or keep the handle in a field and clear it in `dispose()`). As an extra guard, the timer callback could return early when the controller is already disposed (`if (this._disposed) return;`).

Optionally, `LocaleService.t()` could return the key instead of throwing once the service has been disposed, the same as for a missing translation: an asynchronous callback that outlives the instance has nowhere to show the text anyway, and a few other callbacks call `t()` after awaiting something (for example the copy button in `packages/sheets-hyper-link-ui/src/views/CellLinkPopup.tsx` shows its message after `await navigator.clipboard.writeText(…)`; these need a user action first, and we have not reproduced them). Throwing is still useful before the language packs are loaded, so this would only change the behavior after `dispose()`.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); the same code is in 1.0.0. Affected packages: `@univerjs/sheets-formula` (timer), `@univerjs/core` (`LocaleService.t()` throws after dispose).
- Node.js 24.21.0 for the script above; browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, headless.
- OS: macOS 27.0 (Apple silicon).
