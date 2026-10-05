# UR-031 两处 `lifecycleService.onStage(LifecycleStages.Ready).then(...)` 没有接住拒绝：Ready 之前销毁实例（例如创建工作簿抛错之后）时留下没处理的 `LifecycleUnreachableError`

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue（与 UR-029、UR-030 同属"销毁之后还在跑的异步回调"，是否合并见跟踪表"提交之前要确认的事"）
> 出处：延期登记 DEF-057（main `f755729` 的修复者审计发现：sheets-drawing-ui 的浮动宿主一处已核实；engine-formula 的另一处当时是审计员报告、没有核实，这次核实了，见摘要）；平台目前碰不到：现有的重建都在 Ready 之后，打开自检失败时也是 Ready 之后才销毁，只有"编辑器加载失败"一类的路径（创建工作簿抛错之后销毁）会出现。平台没有规避
> 发现版本：1.0.1｜1.0.1 发布包的代码：`@univerjs/sheets-drawing-ui@1.0.1` `lib/es/index.js` 的 `touchSheetsDrawingFloatingHostCapabilityWhenReady`，`@univerjs/engine-formula@1.0.1` `lib/es/index.js` 的 `RegisterOtherFormulaService._initFormulaRegister`，`@univerjs/core@1.0.1` `lib/es/index.js` 的 `LifecycleService.onStage` 与 `Univer._tryProgressToReady`，对照 `@univerjs/ui@1.0.1` 的 `SingleUnitUIController._bootstrapWorkbench`（try/catch）｜1.0.0 源码：相同（本地参考 `refer/univer` 是 v1.0.0；1.0.2 与 `dev` 没有核对）｜发布包上的复现：sheets-drawing-ui 一处——2026-10-06 在只用 SDK 的最小页面上复现（Playwright 1.63.0 的 Chromium 153.0.8010.12 与 WebKit 26.6，无头：`createWorkbook()` 因快照里的工作表是 `null` 抛错，随即 `univer.dispose()`；对照：不注册 `UniverSheetsDrawingUIPlugin`，不出现；创建成功之后销毁，不出现），另在 Node.js 24.21.0 + jsdom 30.1.1 上（表格界面与图片的插件，不画任何东西）复现；engine-formula 一处——Node.js 上复现（在第一个单元创建之前登记一个"其他公式"再销毁，下文的脚本），默认插件里没有找到会让它落空的路径（见摘要）

## 摘要（中文）

core 的 `LifecycleService.onStage(stage)` 返回一个 Promise；实例销毁时 `lifecycle$` 结束，如果那个阶段还没到，Promise 以 `LifecycleUnreachableError` 拒绝（注释里写明了）。ui 的 `SingleUnitUIController._bootstrapWorkbench()` 用 try/catch 接住了这个错误，但还有两处只写了 `.then(...)`：

1. **sheets-drawing-ui 的浮动宿主**（`touchSheetsDrawingFloatingHostCapabilityWhenReady()`，`UniverSheetsDrawingUIPlugin` 与移动端插件的 `onStarting()` 调用它）。表格类插件在第一次创建工作簿时、在 `createUnit()` 里启动；实例里第一个创建的单元是工作簿时（只用表格的应用就是这样），那时还在 Starting，所以走 `onStage(Ready).then(...)`；Ready 在同一次 `createUnit()` 的末尾才到。只要 `createUnit()` 在这中间抛错（插件已经启动、工作簿的构造抛错，例如快照里的工作表是 `null`），Ready 就永远到不了；之后销毁实例，这个 Promise 被拒绝、没有人处理，成为一条 `unhandledrejection`。已在 Chromium、WebKit 与 Node.js（jsdom）上复现；不注册这个插件时不出现。
2. **engine-formula 的 `RegisterOtherFormulaService`**：登记"其他公式"（数据验证、条件格式的公式）时，如果 `SetOtherFormulaMutation`、`OtherFormulaMarkDirty` 还没注册（`FormulaController` 在 Ready 时才创建），就 `onStage(Ready).then(...)` 等到 Ready 再登记。核实的结果：
   - 写法与第 1 处相同，在第一个单元创建之前登记一个其他公式、再销毁实例，Node.js 上复现了没处理的 `LifecycleUnreachableError`；
   - 默认插件里这条分支确实会走：条件格式的公式在 `createUnit()` 载入资源时（Starting）登记（加日志核对过；数据验证的自定义公式那时已是 Ready）；但 Ready 紧接着在同一次 `createUnit()` 里到达，Promise 照常兑现。资源载入（单元加入的通知）之后到 Ready 之间没有找到会抛错的步骤——订阅者里的异常被 RxJS 接住、改为异步报告——所以**没有找到默认插件里会让它落空的路径**，这一处按"同一种写法的潜在问题"写进同一个 issue。

对平台：现有的重建都在 Ready 之后，目前碰不到；"编辑器加载失败"一类的路径（创建工作簿抛错之后销毁）会多一条页面异常，用户看不到，不影响数据。平台没有规避，DEF-057 留到 M5 复核编辑器加载失败的路径时再看。

## 已有的上游讨论

- 没有检索：本次只用本地资源（本地参考源码与 1.0.1 发布包），不访问网络。【待补充：提交之前检索一次，建议的关键词：`LifecycleUnreachableError`、`will never be reached`、`onStage(LifecycleStages.Ready)`、`touchSheetsDrawingFloatingHostCapabilityWhenReady`、`RegisterOtherFormulaService onStage`】

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Two `lifecycleService.onStage(LifecycleStages.Ready).then(…)` calls do not handle the rejection — disposing Univer before the Ready stage (e.g. after `createWorkbook()` threw) leaves an unhandled `LifecycleUnreachableError`

### Describe the bug

`LifecycleService.onStage(stage)` rejects with `LifecycleUnreachableError` when the instance is disposed before the stage is reached (as its documentation says). `SingleUnitUIController._bootstrapWorkbench()` (`@univerjs/ui`) catches that error, but two other call sites only chain `.then()`:

1. `touchSheetsDrawingFloatingHostCapabilityWhenReady()` in `@univerjs/sheets-drawing-ui`, called from `onStarting()` of `UniverSheetsDrawingUIPlugin` and `UniverSheetsDrawingMobileUIPlugin` (and from the exported `registerSheetsDrawingFloatingHostCapability()`);
2. the `_formulaChangeWithRange$` subscription in `RegisterOtherFormulaService` (`@univerjs/engine-formula`), used when an "other formula" (data validation, conditional formatting) is registered before `FormulaController` has registered `SetOtherFormulaMutation` / `OtherFormulaMarkDirty`.

The first one is taken whenever the first unit of the instance is a workbook (as in any sheets-only app): sheet plugins are started inside the first `createUnit()` of a sheet, while the stage is still Starting, and the stage moves to Ready only at the end of that `createUnit()` call. If `createUnit()` throws in between — for example the workbook constructor rejects a malformed snapshot — Ready is never reached, and disposing the instance afterwards rejects the pending promise with nobody handling it.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接；下面的代码已经在本地用 1.0.1 跑过】

**sheets-drawing-ui** (browser). A page with the sheet UI and drawing plugins (we registered `UniverRenderEnginePlugin`, `UniverUIPlugin({ container: 'app' })`, `UniverDocsPlugin`, `UniverDocsUIPlugin`, `UniverFormulaEnginePlugin`, `UniverSheetsPlugin`, `UniverSheetsUIPlugin`, `UniverSheetsFormulaPlugin`, `UniverSheetsFormulaUIPlugin`, `UniverDataValidationPlugin`, `UniverSheetsDataValidationPlugin`, `UniverSheetsDataValidationUIPlugin`, `UniverSheetsNotePlugin`, `UniverSheetsNoteUIPlugin`, `UniverDrawingPlugin`, `UniverDrawingUIPlugin`, `UniverDocsDrawingPlugin`, `UniverSheetsDrawingPlugin`, `UniverSheetsDrawingUIPlugin`, with their CSS and en-US locales):

```js
import { LocaleType, mergeLocales, Univer } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import '@univerjs/sheets/facade';

const t0 = performance.now();
const log = (text) => console.log(`${Math.round(performance.now() - t0)} ms ${text}`);
window.addEventListener('unhandledrejection', (event) => log(`unhandledrejection: ${event.reason?.name}: ${event.reason?.message}`));

const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: mergeLocales(/* en-US packs of the plugins above */) } });
// univer.registerPlugin(…) for the plugins listed above
const univerAPI = FUniver.newAPI(univer);

try {
    // sheet plugins start, then the workbook constructor throws: the stage stays at Starting
    univerAPI.createWorkbook({ id: 'wb', sheetOrder: ['s1'], sheets: { s1: null } });
} catch (error) {
    log(`createWorkbook() threw: ${error.name}: ${error.message}`);
}
univer.dispose();
log('univer.dispose()');
```

**engine-formula** (Node.js; a direct call, to show the second site):

```js
// node repro.cjs
const { LocaleType, Univer } = require('@univerjs/core');
const { RegisterOtherFormulaService, UniverFormulaEnginePlugin } = require('@univerjs/engine-formula');

process.on('unhandledRejection', (error) => console.log(`unhandledRejection: ${error.name}: ${error.message}`));

const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} } });
univer.registerPlugin(UniverFormulaEnginePlugin);
// No unit exists yet: the stage is Starting and FormulaController (created at Ready) has not registered
// SetOtherFormulaMutation, so the registration waits for onStage(LifecycleStages.Ready).
univer.__getInjector().get(RegisterOtherFormulaService).registerFormulaWithRange('wb', 's1', '=A1>0');
univer.dispose();
console.log('univer.dispose() returned');
```

### Expected behavior

Disposing the instance before Ready is a normal way to give up on it (for example after a failed `createWorkbook()`): the pending "when ready" callbacks are dropped silently, as `SingleUnitUIController` already does.

### Actual behavior

sheets-drawing-ui, Chromium 153 (times from the start of the script):

```text
14 ms createWorkbook() threw: TypeError: Cannot destructure property 'name' of 'worksheetSnapshot' as it is null.
17 ms univer.dispose()
19 ms unhandledrejection: LifecycleUnreachableError: [LifecycleService]: lifecycle stage "Ready" will never be reached!
```

WebKit 26.6 gives the same rejection. Without `UniverSheetsDrawingUIPlugin` (everything else the same) there is no rejection, and neither is there one when `createWorkbook()` succeeds before `univer.dispose()`.

engine-formula, `node repro.cjs`:

```text
univer.dispose() returned
unhandledRejection: LifecycleUnreachableError: [LifecycleService]: lifecycle stage "Ready" will never be reached!
```

With the default plugins we did not find a way to leave this second promise pending at disposal: conditional formatting formulas are registered while `createUnit()` loads the resources (stage Starting, so this branch is taken), but Ready follows within the same `createUnit()` call. It is the same pattern, though, and the same fix applies.

### Root cause analysis

Paths are relative to the repository root, at tag v1.0.0 (the same code is in the published 1.0.1 packages).

- `packages/core/src/services/lifecycle/lifecycle.service.ts`: `LifecycleService.dispose()` completes `lifecycle$`; `onStage()` turns the resulting `EmptyError` into `LifecycleUnreachableError` and rejects.
- `packages/core/src/univer.ts`: the create handler installed in `Univer._init()` calls `PluginService.startPluginsForType()` before it constructs the unit and calls `_tryProgressToReady()` only after the unit has been constructed and added; if the constructor throws (e.g. `Workbook._parseWorksheetSnapshots()` on a `null` sheet), the stage stays at Starting.
- `packages/sheets-drawing-ui/src/embed/floating-host/register-sheets-drawing-floating-host.ts`, `touchSheetsDrawingFloatingHostCapabilityWhenReady()`: `lifecycleService.onStage(LifecycleStages.Ready).then(() => { … })` without a rejection handler; called from `onStarting()` in `packages/sheets-drawing-ui/src/plugin.ts` (`UniverSheetsDrawingUIPlugin`) and `packages/sheets-drawing-ui/src/mobile-plugin.ts` (`UniverSheetsDrawingMobileUIPlugin`), where the stage is still below Ready unless a unit of another type was created earlier.
- `packages/engine-formula/src/services/register-other-formula.service.ts`, `RegisterOtherFormulaService._initFormulaRegister()`: the same `.then()` without a rejection handler when the two mutations are not registered yet (they are registered by `FormulaController`, which `UniverFormulaEnginePlugin.onReady()` creates).
- For comparison, `packages/ui/src/controllers/ui/ui-shared.controller.ts`, `SingleUnitUIController._bootstrapWorkbench()` awaits `onStage(LifecycleStages.Ready)` inside `try … catch` and returns on `LifecycleUnreachableError`.

### Suggested fix

Handle the rejection in both places the way `SingleUnitUIController` does, e.g.:

```ts
lifecycleService.onStage(LifecycleStages.Ready).then(() => {
    touchSheetsDrawingFloatingHostCapability(injector);
}).catch((error) => {
    if (error instanceof LifecycleUnreachableError) return; // disposed before Ready: nothing to do
    throw error;
});
```

and the same in `RegisterOtherFormulaService._initFormulaRegister()`. Alternatively core could offer a variant of `onStage()` (or a callback-style helper) that simply never calls back when the stage becomes unreachable, so that call sites cannot forget it.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); the same code is in 1.0.0. Affected packages: `@univerjs/sheets-drawing-ui`, `@univerjs/engine-formula`.
- Browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, headless; the page was served by Vite 8.3.0 (React 19.3.0). Node.js 24.21.0 for the engine-formula script (and for a jsdom 30.1.1 run of the sheets-drawing-ui case with the sheet UI and drawing plugins, same result).
- OS: macOS 27.0 (Apple silicon).
