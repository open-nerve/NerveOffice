# UR-030 数据验证给非当前工作表排的空闲回调不取消、返回的 Promise 不处理：实例或工作簿刚渲染完就销毁时，留下没处理的拒绝"cannot find current workbook"

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue（与 UR-029、UR-031 同属"销毁之后还在跑的异步回调"，是否合并见跟踪表"提交之前要确认的事"）
> 出处：延期登记 DEF-056（main `f755729` 的修复者审计发现；M3-P4 S5 起在打开自检的"先取后放"路径上必现）；P4 设计（`docs/v0.1/M3-编辑权与保存协议/04-P4-自动保存与打开自检.md`）§3.12 的"SDK 的副作用"；审计时的探索用例（Chromium、平台的编辑器页：把空闲回调推迟到阅读→编辑的切换之后，两次都出现；不推迟、CPU 降速 6 倍都没有出现）；E2E `tests/e2e/specs/editor/open-check.spec.ts` 的 `?edit=new` 先取后放用例因此改用"模板 + 截断的筛选"（注释写明）。平台没有规避
> 发现版本：1.0.1｜1.0.1 发布包的代码：`@univerjs/sheets-data-validation@1.0.1` `lib/es/index.js` 的 `SheetsDataValidationValidatorService`（`_initRecalculate` 里的 `requestIdleCallback`、`validatorRanges` 的抛错），`@univerjs/core@1.0.1` 的 `requestIdleCallback` 垫片（`installRequestIdleCallback`）｜1.0.0 源码：相同（本地参考 `refer/univer` 是 v1.0.0；1.0.2 与 `dev` 没有核对）｜发布包上的复现：2026-10-06 在只用 SDK 的最小页面上复现（Playwright 1.63.0，无头；下文的代码）：Chromium 153.0.8010.12（原生 `requestIdleCallback`）在 Rendered 之后 0 ms、50 ms 销毁实例都出现，200 ms 不出现；WebKit 26.6（没有原生的 `requestIdleCallback`，用 core 的 `setTimeout(1)` 垫片）0 ms 出现，16 ms、50 ms 不出现；只销毁工作簿（`univerAPI.disposeUnit('wb')`）两个浏览器同样出现；对照：规则放在当前工作表上，不出现

## 摘要（中文）

sheets-data-validation 的 `SheetsDataValidationValidatorService` 在构造时订阅数据验证的"脏区"（规则载入、单元格改动等）：第一次渲染（Rendered）之前的先缓冲，到 Rendered 时一次处理，之后每 20 ms 一批。处理时，当前工作表上的区域直接校验；**别的工作表上的区域交给 `requestIdleCallback` 延后校验**。这个空闲回调没有登记取消（销毁时不 `cancelIdleCallback`），回调里调用的 `validatorRanges()` 是 async 函数，返回的 Promise 也没有人处理。实例（或这个工作簿）在空闲回调到来之前被销毁时，`validatorRanges()` 找不到工作簿，抛出 `cannot find current workbook, unitId: …`，成为一条没处理的拒绝（`unhandledrejection`，页面异常）。

条件：文档在非当前工作表上有数据验证，并且在第一次渲染之后、浏览器空闲之前销毁实例或工作簿。Chromium 的原生 `requestIdleCallback` 要等到空闲，刚渲染完的一段时间里都会出现（我们测到 50 ms 出现、200 ms 不出现）；没有原生 `requestIdleCallback` 的浏览器（Safari，Playwright 的 WebKit）用 core 的垫片（`setTimeout(1)`），只有同一个任务里或 1 ms 之内销毁才出现。渲染之后的编辑改动牵动非当前工作表的数据验证时走同一条路，按源码同样可能落空（没有试）。

对平台的影响：阅读与编辑之间一律重建编辑器；M3-P4 S5 的打开自检"先取后放"——可编辑的编辑器自检失败时，它刚渲染完就被销毁——在文档的非当前工作表上有数据验证时**必现**。只是一条页面异常，用户看不到，不影响数据；但它会被平台的页面错误检查（E2E）认作异常，相应的 E2E 改用了别的样本。平台没有规避：插件没有替换这个服务的入口（依赖在插件的 `onStarting` 里直接加进注入器），在适配层修只能复刻插件或打补丁；DEF-056 留到 M5 按表格插件逐项验收时评估补丁。

## 已有的上游讨论

- 没有检索：本次只用本地资源（本地参考源码与 1.0.1 发布包），不访问网络。【待补充：提交之前检索一次，建议的关键词：`cannot find current workbook`、`SheetsDataValidationValidatorService`、`requestIdleCallback data validation`、`validatorRanges unhandled`、`dispose data validation idle`】

---

## Issue（英文，可以直接提交）

**Title:** [Bug] sheets-data-validation: the deferred validation of non-active sheets (`requestIdleCallback`) is never cancelled and its promise is not handled — disposing the workbook or the Univer instance right after the first render leaves an unhandled rejection "cannot find current workbook"

### Describe the bug

`SheetsDataValidationValidatorService` (`@univerjs/sheets-data-validation`) collects dirty ranges (rules loaded, cells changed) and validates them: before the Rendered stage they are buffered and handled all at once when Rendered is reached; afterwards they are handled in 20 ms batches. Ranges on the active sheet are validated right away; ranges on **other sheets** are deferred with `requestIdleCallback(() => { this.validatorRanges(…); })`.

That idle callback is never cancelled, and the promise returned by the async `validatorRanges()` is not handled. If the workbook or the whole Univer instance is disposed before the browser becomes idle, `validatorRanges()` cannot find the workbook, throws `cannot find current workbook, unitId: …`, and the result is an unhandled promise rejection.

It happens when a workbook has data validation on a sheet that is not active and is disposed shortly after it has been rendered — for example an app that checks the loaded document after the first render and replaces the instance, or that closes a workbook right after opening it.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接；下面的代码已经在本地用 1.0.1 跑过】

A page with the sheet UI and data validation (we registered `UniverRenderEnginePlugin`, `UniverUIPlugin({ container: 'app' })`, `UniverDocsPlugin`, `UniverDocsUIPlugin`, `UniverFormulaEnginePlugin`, `UniverSheetsPlugin`, `UniverSheetsUIPlugin`, `UniverSheetsFormulaPlugin`, `UniverSheetsFormulaUIPlugin`, `UniverDataValidationPlugin`, `UniverSheetsDataValidationPlugin`, `UniverSheetsDataValidationUIPlugin`, `UniverSheetsNotePlugin`, `UniverSheetsNoteUIPlugin`, with their CSS and en-US locales):

```js
import { LifecycleStages, LocaleType, mergeLocales, Univer } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import '@univerjs/sheets/facade';

const t0 = performance.now();
const log = (text) => console.log(`${Math.round(performance.now() - t0)} ms ${text}`);
window.addEventListener('unhandledrejection', (event) => log(`unhandledrejection: ${event.reason?.name}: ${event.reason?.message}`));

const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: mergeLocales(/* en-US packs of the plugins above */) } });
// univer.registerPlugin(…) for the plugins listed above
const univerAPI = FUniver.newAPI(univer);

// Dispose right after the first render (the same happens with univerAPI.disposeUnit('wb'))
univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, ({ stage }) => {
    if (stage !== LifecycleStages.Rendered) return;
    setTimeout(() => {
        univer.dispose();
        log('univer.dispose() 0 ms after the Rendered stage');
    }, 0);
});

univerAPI.createWorkbook({
    id: 'wb',
    sheetOrder: ['s1', 's2'],
    sheets: {
        s1: { id: 's1', name: 'Sheet1' },
        s2: { id: 's2', name: 'Sheet2', cellData: { 0: { 0: { v: 5 } } } },
    },
    resources: [{
        name: 'SHEET_DATA_VALIDATION_PLUGIN',
        // a rule on Sheet2, which is not the active sheet
        data: JSON.stringify({
            s2: [{ uid: 'dv1', type: 'decimal', operator: 'between', formula1: '1', formula2: '10', ranges: [{ startRow: 0, endRow: 9, startColumn: 0, endColumn: 0 }] }],
        }),
    }],
});
```

### Expected behavior

Disposing the workbook or the instance cancels the pending validation of other sheets (or the callback notices that the workbook is gone and does nothing). No error is reported.

### Actual behavior

Chromium 153 (native `requestIdleCallback`), times from the start of the script:

```text
562 ms univer.dispose() 0 ms after the Rendered stage
564 ms unhandledrejection: Error: cannot find current workbook, unitId: wb
```

- Disposing 50 ms after the Rendered stage gives the same rejection; 200 ms after, it does not (the browser was idle in between).
- `univerAPI.disposeUnit('wb')` instead of `univer.dispose()` gives the same rejection.
- With the rule on the active sheet (`s1`), there is no rejection.
- WebKit 26.6 has no native `requestIdleCallback`, so the shim installed by `@univerjs/core` (`setTimeout(…, 1)`) is used: disposing in a 0 ms timeout after the Rendered stage gives the same rejection, disposing 16 ms or 50 ms after it does not.

### Root cause analysis

Paths are relative to the repository root, at tag v1.0.0 (the same code is in the published 1.0.1 packages).

- `packages/sheets-data-validation/src/services/dv-validator.service.ts`, `SheetsDataValidationValidatorService`:
  - `_initRecalculate()` subscribes to `DataValidationCacheService.dirtyRanges$` twice: buffered until the Rendered stage (`bufferWhen` on `lifecycle$`), and in 20 ms batches afterwards (`bufferDebounceTime(20)`). Both call `handleDirtyRanges`.
  - `handleDirtyRanges` validates the ranges of the active sheet with `this.validatorRanges(…)` and defers all other sheets with `requestIdleCallback(() => { this.validatorRanges(…); })`. The id is not kept, so nothing can cancel it, and neither call handles the returned promise.
  - `validatorRanges()` is `async` and throws `cannot find current workbook, unitId: ${unitId}` when `IUniverInstanceService.getUnit()` returns nothing, which is the case once the unit (or the whole instance) has been disposed. Because it is `async`, the error becomes a rejected promise that nobody handles.
- `packages/core/src/common/shims.ts`, `installRequestIdleCallback()`: where `requestIdleCallback` is missing (Safari), the shim calls back after `setTimeout(…, 1)`, so the window is very small there; with the native implementation (Chromium) the callback waits for an idle period, which right after the first render took more than 50 ms in our runs.

### Suggested fix

Track the deferred callbacks, cancel them on dispose, and make the deferred validation tolerate a workbook that has gone away, e.g.:

```ts
private readonly _idleCallbacks = new Set<number>();

// in handleDirtyRanges
const id = requestIdleCallback(() => {
    this._idleCallbacks.delete(id);
    if (this._disposed || !this._univerInstanceService.getUnit(unitId, UniverInstanceType.UNIVER_SHEET)) return;
    this.validatorRanges(unitId, subUnitId, ranges).catch(() => { /* the workbook was disposed meanwhile */ });
});
this._idleCallbacks.add(id);

override dispose(): void {
    super.dispose();
    this._idleCallbacks.forEach((id) => cancelIdleCallback(id));
    this._idleCallbacks.clear();
}
```

The unit check covers `disposeUnit()` while the instance stays alive. Handling (or at least not leaving unhandled) the promise of the direct `validatorRanges()` call for the active sheet would be consistent as well.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); the same code is in 1.0.0. Affected package: `@univerjs/sheets-data-validation`.
- Browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, headless; the page was served by Vite 8.3.0 (React 19.3.0).
- OS: macOS 27.0 (Apple silicon).
