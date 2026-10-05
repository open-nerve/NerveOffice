# UR-032 公式引擎在本线程运行时，实例在一轮计算中被销毁，这一轮不会停下：它把 `#NAME?` 的语法树写进模块级的缓存，之后同一页里新建的实例（同一个 unitId）算出 `#NAME?`

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M3-P4 S1 真实 Safari 复核的 F2（`docs/v0.1/M3-编辑权与保存协议/reviews/P4-S1-真实Safari复核.md` §四 F2：真实 Safari 27.0 与 Playwright 的 WebKit 26.6、Chromium、Chrome 都复现，811 个公式里 110–350 个得出 `#NAME?`，Worker 模式不受影响）；P4 设计（`docs/v0.1/M3-编辑权与保存协议/04-P4-自动保存与打开自检.md`）§3.14；ADR-010"M3-P4 的补充"的"主线程公式模式"；内部 API 登记 `FORMULA_PROTOCOL`（`apps/web/src/editor/internal-api/registry.ts`，依赖的约定与证据）；平台的规避（S5）`apps/web/src/editor/formula-round-stop.ts`、`apps/web/src/editor/sheet-editor.ts` 的销毁与编辑器槽位（新建之前等上一次销毁完），回归 E2E `tests/e2e/specs/editor/formula-rebuild.spec.ts` 与页面自检的 `formula.rebuild-during-calc`
> 发现版本：1.0.1｜1.0.1 发布包的代码：`@univerjs/engine-formula@1.0.1` `lib/es/index.js` 的 `FORMULA_AST_CACHE` 与 `generateAstNode`、`CalculateFormulaService`（`_apply` 的让出与停止检查、`dispose`）、`FormulaRuntimeService`（`dispose` 调 `reset`，`reset` 复位 `_stopState`）、`FunctionService.dispose`、`FormulaDependencyGenerator.dispose`、`ErrorFunctionNode`｜1.0.0 源码：相同（本地参考 `refer/univer` 是 v1.0.0；1.0.2 与 `dev` 没有核对）｜发布包上的复现：2026-10-06 用 1.0.1 发布包在 Node.js 24.21.0 上复现（下文的脚本，引擎的默认配置：3,000 个公式里 999 个 `#NAME?`；B 晚 3 秒创建、或在 B 里强制全量重算，仍是 999 个；对照：先停下这一轮、等到结束的通知再销毁，0 个；算完再销毁，0 个）；同一天在只用 SDK 的最小页面上复现（Playwright 1.63.0，无头：Chromium 153.0.8010.12 是 999 个，WebKit 26.6 是 1,499 个）

## 摘要（中文）

公式引擎在本线程运行时（不配 Worker；Node.js 里总是这样，也是平台 M4 的退路），一轮计算逐个公式现建语法树，每 `intervalCount` 个公式让出一次（MessageChannel 宏任务），让出回来才检查停止标记。实例在这一轮进行中被销毁时：

1. `FormulaRuntimeService.dispose()` 调 `reset()`，把停止标记复位为 `false`——销毁不但不停下这一轮，连之前发出的停止也会被抹掉；
2. `CalculateFormulaService` 没有"已销毁"的检查，挂起的让出也不取消，旧的循环在下一个让出点之后接着把剩下的公式算完；
3. `FunctionService.dispose()` 已经清空了函数表，旧循环现建的语法树里函数节点建不出来（`hasExecutor()` 为假），退成 `ErrorFunctionNode`，执行得 `#NAME?`；
4. 语法树缓存 `FORMULA_AST_CACHE` 是 engine-formula 的**模块级**变量（同一页、同一个 Node.js 进程里所有实例共用），键是 `unitId:工作表:列:行:公式`；销毁时 `FormulaDependencyGenerator.dispose()` 清过一次，但旧循环是在那之后才把坏的语法树写进去的；
5. 之后新建的实例只要 `unitId` 与工作表 id 相同（重新打开同一份文档就是这样），算到这些格时命中坏的语法树，得出 `#NAME?`，写进单元格、随保存写进快照；强制全量重算也一样（缓存只在定义名称、超级表有改动时才重建），直到被 LRU（5,000 项）挤掉，或者有别的实例在销毁时再清一次缓存。

Worker 模式下引擎与这份缓存都在 Worker 里，平台销毁编辑器时终止 Worker，所以不受影响。

对平台的影响：M3 的生产只用 Worker 模式；主线程模式是 M4 的退路（Worker 起不来时用它），阅读与编辑之间一律重建编辑器，那时每一次"计算中重建"（打开含没有结果的公式马上点"编辑"、阅读时"有更新"、失去编辑权之后的重建）都会把 `#NAME?` 存进文档。平台的规避（M3-P4 S5 已落地）：主线程模式下销毁之前，如果有一轮在算，先执行停止的 mutation（`onlyLocal`）、等这一轮结束的通知（`STOP_EXECUTION`）再销毁，时限 30 秒；代价最多一个让出间隔。实测停下到收到结束通知 0–5 ms；去掉规避时 170–410 个公式得出 `#NAME?`。M4 把主线程模式变成生产的退路时必须保留这条规避（ADR-010）。

## 已有的上游讨论

- 没有检索：本次只用本地资源（本地参考源码与 1.0.1 发布包），不访问网络。【待补充：提交之前检索一次，建议的关键词：`FORMULA_AST_CACHE`、`#NAME? after dispose`、`dispose during calculation`、`stopFormulaExecution dispose`、`_stopState reset`、`generateAstNode cache`】

---

## Issue（英文，可以直接提交）

**Title:** [Bug] engine-formula (calculation in the same thread): disposing Univer during a calculation does not stop it — the leftover loop puts `#NAME?` ASTs into the module-level `FORMULA_AST_CACHE`, and a new instance with the same unit id computes `#NAME?`

### Describe the bug

When the formula engine runs in the same thread as Univer (no web worker — always the case in Node.js), disposing a Univer instance while a calculation is running does not stop that calculation, and what the leftover calculation does afterwards corrupts later instances:

1. `FormulaRuntimeService.dispose()` calls `reset()`, which sets the stop flag back to `false`, so disposal even clears a stop that was requested before.
2. `CalculateFormulaService` has no "disposed" check and does not cancel its pending yield, so the loop in `_apply()` resumes after the next yield point (`requestImmediateMacroTask`), sees no stop request and processes the remaining formulas.
3. `FunctionService.dispose()` has cleared the function executors, so for every remaining formula the AST is built without functions: `FunctionNodeFactory` does not recognize `SUM`, `ROUND` etc. (`hasExecutor()` is `false`), `AstTreeBuilder` falls back to `ErrorFunctionNode`, which evaluates to `#NAME?`.
4. `generateAstNode()` stores these ASTs in `FORMULA_AST_CACHE`, a module-level LRU cache shared by all Univer instances in the page (or Node.js process), keyed by `unitId:subUnitId:x:y:formula`. `FormulaDependencyGenerator.dispose()` cleared the cache during disposal, but the leftover loop writes to it afterwards.
5. An instance created later for the same workbook (same unit id and sheet ids — e.g. the same document opened again) hits the cached broken ASTs and computes `#NAME?` for those cells. A forced full recalculation does not help (the cached AST is only rebuilt when defined names or super tables change), and the wrong values are written into the cells and saved with the snapshot.

With the engine in a web worker the cache lives in the worker; we terminate the worker together with the instance and do not see the problem there.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的仓库或 StackBlitz（Node 模板）链接；下面的脚本已经在本地用 1.0.1 跑过】

Node.js, public APIs only (the same happens in the browser with the default plugin configuration, see "Actual behavior"):

```js
// node repro.cjs [rebuild|stop-first|after|fresh]
//   rebuild:    dispose instance A while its calculation is running, then create B from the same snapshot
//   stop-first: stop A's calculation, wait for the STOP_EXECUTION notification, then dispose A and create B
//   after:      dispose A after its calculation has finished, then create B
//   fresh:      only B
// env: B_DELAY=<ms> creates B that much later; FORCE_AGAIN=1 forces a full recalculation in B afterwards
const { LocaleType, LogLevel, Univer, UniverInstanceType } = require('@univerjs/core');
const { FUniver } = require('@univerjs/core/facade');
const { UniverSheetsPlugin } = require('@univerjs/sheets');
const { FormulaExecutedStateType, FormulaExecuteStageType, SetFormulaCalculationNotificationMutation, UniverFormulaEnginePlugin } = require('@univerjs/engine-formula');
const { UniverSheetsFormulaPlugin } = require('@univerjs/sheets-formula');
require('@univerjs/sheets/facade');
require('@univerjs/engine-formula/facade');

const variant = process.argv[2] ?? 'rebuild';
const ROWS = 300;
const COLS = 10;
const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)} ms`;
process.on('uncaughtException', (error) => console.log(`${ms()} uncaughtException: ${error.message}`)); // a separate issue (progress timer), unrelated here

// 3,000 formulas without cached values, all in the same workbook id 'wb'
function snapshot() {
    const cellData = {};
    for (let r = 0; r < ROWS; r++) {
        cellData[r] = { 0: { v: r + 1 } };
        for (let c = 1; c <= COLS; c++) cellData[r][c] = { f: `=SUM($A$1:$A$${ROWS})+ROUND(ROW()*${c}/3,0)` };
    }
    return { id: 'wb', sheetOrder: ['s1'], sheets: { s1: { id: 's1', name: 'Sheet1', rowCount: ROWS, columnCount: COLS + 1, cellData } } };
}

function create(name, onNotification) {
    const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} }, logLevel: LogLevel.ERROR });
    univer.registerPlugin(UniverSheetsPlugin);
    univer.registerPlugin(UniverFormulaEnginePlugin); // default config: the engine runs in this thread
    univer.registerPlugin(UniverSheetsFormulaPlugin);
    const univerAPI = FUniver.newAPI(univer);
    univerAPI.addEvent(univerAPI.Event.CommandExecuted, ({ id, params }) => {
        if (id !== SetFormulaCalculationNotificationMutation.id) return;
        if (params.stageInfo?.stage === FormulaExecuteStageType.START) console.log(`${ms()} ${name}: calculation started`);
        if (params.stageInfo == null) console.log(`${ms()} ${name}: calculation finished (${FormulaExecutedStateType[params.functionsExecutedState]})`);
        onNotification(params);
    });
    univer.createUnit(UniverInstanceType.UNIVER_SHEET, snapshot());
    return { univer, univerAPI };
}

function count(univerAPI) {
    const range = univerAPI.getActiveWorkbook().getSheetBySheetId('s1').getRange(0, 1, ROWS, COLS);
    const values = range.getValues();
    const expected = (ROWS * (ROWS + 1)) / 2;
    let wrong = 0;
    let names = 0;
    values.forEach((row, r) => row.forEach((v, i) => {
        if (v === '#NAME?') names++;
        if (v !== expected + Math.round(((r + 1) * (i + 1)) / 3)) wrong++;
    }));
    return `${ROWS * COLS} formulas, ${wrong} wrong, ${names} of them #NAME?`;
}

function createB() {
    let ends = 0;
    const b = create('B', (params) => {
        if (params.stageInfo != null) return;
        ends++;
        setTimeout(() => {
            console.log(`${ms()} B: ${count(b.univerAPI)}`);
            if (ends === 1 && process.env.FORCE_AGAIN) {
                console.log(`${ms()} B: univerAPI.getFormula().executeCalculation()`);
                b.univerAPI.getFormula().executeCalculation();
            } else {
                b.univer.dispose();
            }
        }, 50);
    });
}

const disposeAThenCreateB = (a, when) => setTimeout(() => {
    a.univer.dispose();
    console.log(`${ms()} A: univer.dispose() ${when}`);
    setTimeout(createB, Number(process.env.B_DELAY ?? 0));
}, 0);

if (variant === 'fresh') {
    createB();
} else {
    let progress = 0;
    const a = create('A', (params) => {
        if (params.stageInfo?.stage === FormulaExecuteStageType.CURRENTLY_CALCULATING && ++progress === 3) {
            const { completedFormulasCount, totalFormulasToCalculate } = params.stageInfo;
            if (variant === 'rebuild') disposeAThenCreateB(a, `during the calculation (${completedFormulasCount}/${totalFormulasToCalculate})`);
            if (variant === 'stop-first') {
                console.log(`${ms()} A: univerAPI.getFormula().stopCalculation()`);
                setTimeout(() => a.univerAPI.getFormula().stopCalculation(), 0);
            }
        }
        if (params.stageInfo == null && variant !== 'rebuild') disposeAThenCreateB(a, 'after the end notification');
    });
}
```

### Expected behavior

Disposing an instance stops its calculation (or at least whatever is left of it does not touch state shared with other instances). B computes the same values as when it is created on its own (`fresh`): 3,000 formulas, 0 wrong.

### Actual behavior

Output on 1.0.1:

```text
== node repro.cjs fresh
40 ms B: calculation started
281 ms B: calculation finished (SUCCESS)
332 ms B: 3000 formulas, 0 wrong, 0 of them #NAME?

== node repro.cjs rebuild
41 ms A: calculation started
237 ms A: univer.dispose() during the calculation (1001/3000)
261 ms B: calculation started
421 ms B: calculation finished (SUCCESS)
472 ms B: 3000 formulas, 999 wrong, 999 of them #NAME?
1047 ms uncaughtException: [LocaleService]: Locale not initialized

== node repro.cjs stop-first
40 ms A: calculation started
201 ms A: univerAPI.getFormula().stopCalculation()
229 ms A: calculation finished (STOP_EXECUTION)
231 ms A: univer.dispose() after the end notification
252 ms B: calculation started
468 ms B: calculation finished (SUCCESS)
520 ms B: 3000 formulas, 0 wrong, 0 of them #NAME?

== node repro.cjs after
42 ms A: calculation started
280 ms A: calculation finished (SUCCESS)
281 ms A: univer.dispose() after the end notification
301 ms B: calculation started
514 ms B: calculation finished (SUCCESS)
565 ms B: 3000 formulas, 0 wrong, 0 of them #NAME?

== FORCE_AGAIN=1 B_DELAY=3000 node repro.cjs rebuild
40 ms A: calculation started
232 ms A: univer.dispose() during the calculation (1001/3000)
1046 ms uncaughtException: [LocaleService]: Locale not initialized
3257 ms B: calculation started
3422 ms B: calculation finished (SUCCESS)
3473 ms B: 3000 formulas, 999 wrong, 999 of them #NAME?
3476 ms B: univerAPI.getFormula().executeCalculation()
3491 ms B: calculation started
3620 ms B: calculation finished (SUCCESS)
3671 ms B: 3000 formulas, 999 wrong, 999 of them #NAME?
```

The number of broken cells depends on how far A had got when it was disposed (with `intervalCount: 20` we saw 400–740 of 3,000). The `uncaughtException` comes from the progress timer of `TriggerCalculationController`, which is a separate issue.

In the browser (a minimal page with the SDK only and the default plugin configuration; A disposed during its initial calculation, B created in the same container from the same snapshot): Chromium 153 gave 999 and WebKit 26.6 gave 1,499 `#NAME?` out of 3,000. In our application (engine in the same thread, `intervalCount: 20`, 811 formulas) Safari 27, WebKit, Chromium and Chrome gave 110–350 `#NAME?` after the editor was recreated during a calculation.

### Root cause analysis

Paths are relative to the repository root, at tag v1.0.0 (the same code is in the published 1.0.1 packages).

- `packages/engine-formula/src/services/runtime.service.ts`, `FormulaRuntimeService`: `dispose()` calls `reset()`, and `reset()` sets `_stopState = false`; `stopExecution()` / `isStopExecution()` are the only stop mechanism.
- `packages/engine-formula/src/services/calculate-formula.service.ts`, `CalculateFormulaService`:
  - `_apply()` builds each AST with `generateAstNode()` and, every `intervalCount` formulas (`DEFAULT_INTERVAL_COUNT` = 500), awaits `requestImmediateMacroTask()`; only after that await does it check `isStopExecution()`. The cancel functions are collected in a local `pendingTasks` array, so `dispose()` cannot cancel the pending yield.
  - `dispose()` completes the listener subjects and clears some module-level caches, but neither stops the loop nor makes it notice the disposal; `execute()` and `_executeStep()` have no disposed check either.
- `packages/engine-formula/src/services/function.service.ts`, `FunctionService.dispose()`: clears `_functionExecutors`.
- `packages/engine-formula/src/engine/ast-node/function-node.ts`, `FunctionNodeFactory.checkAndCreateNodeType()`: creates a function node only if `hasExecutor()`; `packages/engine-formula/src/engine/analysis/parser.ts`, `AstTreeBuilder._checkAstNode()`: falls back to `ErrorFunctionNode`, whose `execute()` sets `#NAME?`.
- `packages/engine-formula/src/engine/utils/generate-ast-node.ts`: `FORMULA_AST_CACHE` is a module-level `FormulaAstLRU` (5,000 entries); `generateAstNode()` builds the key from `unitId`, the sheet id, the offsets and the formula string, returns a cached AST unless defined names or super tables are dirty, and stores every newly parsed AST.
- `packages/engine-formula/src/engine/dependency/formula-dependency.ts`, `FormulaDependencyGenerator`: `dispose()` clears `FORMULA_AST_CACHE` (and `_disposeByUnitId()` deletes the keys of a unit when the unit is disposed while the generator is alive). Disposal is synchronous, so this happens before the leftover loop resumes and writes its broken ASTs; nothing clears them afterwards.

### Suggested fix

1. Stop the calculation when the engine is disposed: for example let `CalculateFormulaService` check `this._disposed` after every `await` in `execute()`, `_executeStep()` and `_apply()` and return without touching shared state, keep the pending macro task in a field so that `dispose()` can cancel it, and make sure `FormulaRuntimeService.dispose()` does not turn a requested stop back into "running" (call `stopExecution()` after `reset()`, or check a separate disposed flag in `isStopExecution()`).
2. Do not let one instance write into a cache another instance reads: hold the AST cache in a service of each instance instead of a module-level constant (the other module-level caches cleared in `CalculateFormulaService.dispose()` are shared in the same way), or at least do not store ASTs built after disposal.

Until then, the workaround that works for us: before disposing, if a calculation is running, call `univerAPI.getFormula().stopCalculation()` (or execute `SetFormulaCalculationStopMutation`), wait for the end notification with `functionsExecutedState === FormulaExecutedStateType.STOP_EXECUTION` (it comes at the next yield point, i.e. within `intervalCount` formulas), and only then call `univer.dispose()`.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); the same code is in 1.0.0. Affected package: `@univerjs/engine-formula`.
- Node.js 24.21.0 for the script above; browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, headless (page served by Vite 8.3.0); in our application also Google Chrome and Safari 27.0.
- OS: macOS 27.0 (Apple silicon).
