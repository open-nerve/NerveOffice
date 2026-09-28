# UR-001 Worker 模式下，公式计算会话在第一张工作表的结果写回后就标记完成

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P3 报告 §3.3 第 2 条、§3.4、§6.3（`docs/v0.1/M0-技术验证/reports/P3-验证报告.md`）；用例 `spikes/m0/e2e/v07-worker-timeline.spec.ts`、`spikes/m0/e2e/v07-formula.spec.ts`，结果 `spikes/m0/e2e/results/v07/timeline/`、`spikes/m0/e2e/results/v07/*-worker.json`；P3 交接单"已知的坑"与"上游报告"｜发现版本：1.0.0｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/sheets-formula@1.0.1` `lib/es/index.js` 第 2946–2956 行（每条写回都按"类型"标记已写回）、`@univerjs/engine-formula@1.0.1` `lib/es/index.js` 第 15207–15406 行（会话只按类型记账）、`@univerjs/sheets@1.0.1` `lib/es/index.js` 第 17799–17841 行（每张表一条写回）、`@univerjs/rpc@1.0.1` `lib/es/index.js` 第 625–643 行（逐条同步），与 1.0.0 源码相同（另见 M1-P4 设计 §3.9：1.0.1 的产物与 1.0.0 相同）；M1-P4 在 1.0.1 的 Worker 模式下录到的命令序列（`apps/web/src/editor/change-tracking/formula-sequences.test-support.ts`）仍是"结果 → 逐表写回 → 完成通知"；GitHub 上 `dev` 分支与 `v1.0.2` 标签的源码（2026-09-28）也没有改

## 摘要（中文）

表格启用公式 Web Worker 时，一轮计算如果有多张工作表的结果，Worker 会按工作表逐条执行 `sheet.mutation.set-range-values`，每条各自经一条消息同步回主线程。主线程的公式会话只按"类型"记账（`SHEET` 一项），收到第一张表的写回就把整轮标为"结果已写回"，`onCalculationResultApplied()` 随即返回（`calculationResultApplied` 的通知也从同一处发出），其余工作表的结果几毫秒之后才到（我们的记录里是 0–4 ms）。调用方在返回之后立即读取或保存，除第一张表外拿到的都是旧的公式值。M0-P3 实测（三个浏览器一致）：只用这个等待接口时，Worker 模式下慢计算表 200/200、跨表引用 1/3 的公式在快照里是旧值；主线程模式没有这个问题。旧值一旦保存，默认的打开方式不会重算，会一直留在服务端。平台现在不用 `onCalculationResultApplied`，改为按 mutation 自己判断"收齐"：最近一条结果里每张有结果的表都收到带 `applyFormulaCalculationResult` 的写回，而且没有排队的一轮、这一轮没有被 stop（`apps/web/src/editor/change-tracking/formula-settle-tracker.ts`，依赖的内部约定在编辑器适配层登记）。

## 已有的上游讨论

没有找到针对这个缺陷的 issue 或 PR（2026-09-28 检索）。检索用的关键词：`onCalculationResultApplied`、`calculationResultApplied`、`FormulaCalculationSessionService`、`applyFormulaCalculationResult`、`waitForLatestApplied`、`resultApplied`、`whenComputingCompleteAsync`、`onCalculationEnd`、`formula worker result`、`formula session sheet applied`、`calculation end worker is:issue`、`is:pr is:open formula`（GitHub 搜索接口），以及网页搜索"univer onCalculationResultApplied worker returns before all sheets applied"。

相关但没有解决这个问题的历史：

- [#6947](https://github.com/dream-num/univer/pull/6947) fix(facade): fix onCalculationResultApplied api used with worker —— 已合并（2026-05-25），引入了公式会话服务，以及"每条带 `applyFormulaCalculationResult` 的写回都调用 `markResultApplied()`"的做法（1.0.0 里这部分逻辑没变，会话服务已移到 engine-formula）；
- [#6907](https://github.com/dream-num/univer/pull/6907)（已合并，2026-05-16，等待条件格式、数据验证等其他公式的结果）、[#6522](https://github.com/dream-num/univer/pull/6522)（已合并，2026-01-27）；
- [#7743](https://github.com/dream-num/univer/pull/7743)（未合并关闭）提到"表格结果可能在计算完成之后才到达"，处理的是 OtherFormula 的刷新，与本问题无关。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Formula Web Worker: `onCalculationResultApplied()` resolves after the first worksheet's results are applied, before the remaining worksheets

### Describe the bug

When formulas are calculated in a Web Worker (main thread: `UniverRPCMainThreadPlugin` and `notExecuteFormula: true`, i.e. the setup behind `UniverSheetsCorePreset({ workerURL })`), a calculation round that produces results on several worksheets is applied on the main thread as one `sheet.mutation.set-range-values` per worksheet, and each of them arrives as a separate RPC message.

The main-thread `FormulaCalculationSessionService` marks the whole result as applied as soon as the **first** of these write-backs has been executed. `univerAPI.getFormula().onCalculationResultApplied()` therefore resolves while the other worksheets still hold their previous values; their write-backs arrive a few milliseconds later (0–4 ms in our runs).

The facade documents `onCalculationResultApplied()` as "Waits until the latest formula-calculation results have been applied" and `calculationResultApplied()` as "Listens for formula results after every affected model has applied them". Code that reads or saves the workbook right after the promise resolves (for example `save()` for persistence) captures stale formula values. In main-thread mode the same API behaves correctly.

### To reproduce

Reproduction link: 【待补充：提交前把下面的片段放进官方 StackBlitz 模板（Worker 配置），生成复现链接】

1. Calculate formulas in a Web Worker: `UniverSheetsCorePreset({ workerURL })` on the main thread and `UniverSheetsCoreWorkerPreset()` in the worker, or the equivalent plugins (main thread: `UniverRPCMainThreadPlugin`, `notExecuteFormula: true` on `UniverFormulaEnginePlugin`, `UniverSheetsPlugin` and `UniverSheetsFormulaPlugin`; worker: `UniverSheetsPlugin({ onlyRegisterFormulaRelatedMutations: true })`, `UniverFormulaEnginePlugin`, `UniverRPCWorkerThreadPlugin`, `UniverRemoteSheetsFormulaPlugin`).
2. Run the following snippet (public Facade API only). It adds two worksheets whose formulas depend on `Agg!B1`, edits `Agg!B1`, and logs every per-sheet write-back and the moment the promise resolves.

   ```ts
   const formula = univerAPI.getFormula();
   const wb = univerAPI.getActiveWorkbook()!;

   // Two worksheets whose formulas depend on Agg!B1.
   const agg: Record<number, Record<number, { v?: number; f?: string }>> = {};
   for (let i = 0; i < 20000; i++) agg[i] = { 1: { v: (i * 37) % 1001 } };
   agg[0][2] = { f: '=SUM(B1:B20000)' };
   wb.insertSheet('Agg', { sheet: { rowCount: 20100, columnCount: 5, cellData: agg } });
   const slow: Record<number, Record<number, { f: string }>> = {};
   for (let i = 0; i < 200; i++) slow[i] = { 0: { f: `=SUMPRODUCT((Agg!$B$1:$B$20000>${i * 5})*Agg!$B$1:$B$20000)` } };
   wb.insertSheet('Slow', { sheet: { rowCount: 220, columnCount: 5, cellData: slow } });
   await formula.onCalculationResultApplied(60000);
   await new Promise((r) => setTimeout(r, 3000)); // let the initial calculation settle

   const sheetName = (id: string) => wb.getSheets().find((s) => s.getSheetId() === id)?.getSheetName() ?? id;
   const t0 = performance.now();
   const log = (msg: string) => console.log(Math.round(performance.now() - t0), msg);
   const sub = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (e) => {
       const p = e.params as any;
       if (e.id === 'formula.mutation.set-formula-calculation-result') {
           log(`result for: ${Object.values(p.unitData).flatMap((u: any) => Object.keys(u).map(sheetName)).join(', ')}`);
       } else if (e.id === 'sheet.mutation.set-range-values' && e.options?.applyFormulaCalculationResult) {
           log(`applied: ${sheetName(p.subUnitId)}`);
       }
   });
   const values = () => `Agg!C1 = ${wb.getSheetByName('Agg')!.getRange('C1').getValue()}, Slow!A1 = ${wb.getSheetByName('Slow')!.getRange('A1').getValue()}`;
   log(`before the edit: ${values()}`);
   wb.getSheetByName('Agg')!.getRange('B1').setValue(88888);
   await formula.onCalculationResultApplied(60000);
   log(`onCalculationResultApplied() resolved: ${values()}`);
   await new Promise((r) => setTimeout(r, 2000));
   log(`2 s later: ${values()}`);
   sub.dispose();
   ```

3. Compare the position of the "resolved" line with the "applied: …" lines, and the values at resolution with the values 2 s later.

Our recorded runs used a larger workbook (a 200-step dependency chain, a 20,000-row aggregate sheet, cross-sheet references, 200 `SUMPRODUCT`s over 20,000 rows and volatile functions on five sheets; sheet names below are translated). The snippet keeps only what is needed to get results on more than one worksheet. 【待补充：这个两张表的精简片段还没有在浏览器里跑过，提交前按它实跑一次，把输出补进 Actual behavior】

### Expected behavior

The promise resolves (and `calculationResultApplied` fires) only after every worksheet contained in the latest `formula.mutation.set-formula-calculation-result` has been written back, as it does in main-thread mode.

### Actual behavior

In Worker mode the promise resolves right after the first worksheet's write-back. Timeline probe (edit `Agg!B1`; the result mutation contained four worksheets: Agg, Cross, Slow, Volatile; milliseconds after the edit):

| Browser | result | applied Agg | **resolved** | applied Cross | applied Slow | applied Volatile | completion notification |
|---|---|---|---|---|---|---|---|
| Chromium 153.0.8010.12 | 2367 | 2368 | **2368** | 2368 | 2368 | 2371 | 2372 |
| Chrome 153.0.8010.53 | 2425 | 2425 | **2426** | 2426 | 2427 | 2429 | 2430 |
| WebKit 26.6 | 929 | 929 | **929** | 929 | 930 | 933 | 935 |

When the promise resolved, `Slow!A1` still had its old value (9927165; it became 10016042 with the "applied Slow" write-back) in all three browsers. In main-thread mode, same browsers and workbook, the promise resolved after all four write-backs and the completion notification (Chromium: write-backs at 2391–2394 ms, notification at 2395 ms, resolved at 2395 ms).

Saving (`save()`) immediately after `onCalculationResultApplied()` resolved stored stale cached values in Worker mode: 200/200 `SUMPRODUCT` formulas on the Slow sheet and 1/3 cross-sheet formulas, in all three browsers; 0 in main-thread mode. The model itself was correct once the remaining write-backs arrived.

### Root cause analysis

Paths are relative to the repository root; line numbers refer to tag v1.0.0.

- `packages/sheets/src/plugin.ts` L140-142: with `notExecuteFormula` the main thread does not register `CalculateResultApplyController`, so results are applied in the worker.
- `packages/sheets/src/controllers/calculate-result-apply.controller.ts` L49-98: the result is applied as one `SetRangeValuesMutation` per worksheet, executed with `{ onlyLocal, fromFormula, applyFormulaCalculationResult }`.
- `packages/rpc/src/controllers/data-sync/data-sync-replica.controller.ts` L59-70: in the worker, every executed mutation is sent to the main thread individually; `packages/rpc/src/services/remote-instance/remote-instance.service.ts` L40-47 executes each one on the main thread with the original options (so `applyFormulaCalculationResult` is kept). Every per-sheet write-back is therefore handled in its own macrotask on the main thread.
- `packages/engine-formula/src/controllers/formula-calculation-session.controller.ts` L97-113: when the result mutation arrives, the pending set is built per **type** — `FormulaResultApplicationType.SHEET` once, however many worksheets `unitData` contains.
- `packages/sheets-formula/src/controllers/sheet-formula-calculation-result-apply.controller.ts` L28-34: every `SetRangeValuesMutation` with `applyFormulaCalculationResult` calls `markResultApplied(FormulaResultApplicationType.SHEET)`.
- `packages/engine-formula/src/services/formula/formula-calculation-session.service.ts` L173-199: the first of these calls removes `SHEET` from the pending set, emits `resultApplied: true` and `resultApplied$`; `waitForLatestApplied()` (L202-328) then resolves in a microtask (L251-277), i.e. before the next worksheet's message is processed.

In main-thread mode `CalculateResultApplyController` executes all per-sheet mutations synchronously inside one listener, so the microtask runs after the last write-back; that is why only Worker mode is affected. `calculationResultApplied()` (`packages/engine-formula/src/facade/f-formula.ts` L216-227) is driven by the same `resultApplied$` emission and is therefore also emitted early; because the facade defers the callback with `requestIdleCallback`, whether a listener actually observes stale values depends on timing (we did not verify this separately).

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. Affected packages: `@univerjs/engine-formula`, `@univerjs/sheets-formula` (Worker path through `@univerjs/rpc`). The code is unchanged on `dev` and in `v1.0.2` (checked on 2026-09-28).
- Browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, Google Chrome 153.0.8010.53; all headless, driven by Playwright.
- OS: macOS 26.5.1 (Apple M4 Pro).

### Suggested fix

- Track pending sheet applications per `unitId`/`subUnitId` instead of per type: when the result mutation arrives, record the worksheets that `CalculateResultApplyController` will write (non-null cell data on existing worksheets, `calculate-result-apply.controller.ts` L49-88); let `SheetFormulaCalculationResultApplyController` report the `unitId`/`subUnitId` of each applied `SetRangeValuesMutation`; mark `SHEET` as applied only when every recorded worksheet has been written back (dropping worksheets removed in the meantime).
- Alternatively, in Worker mode, treat a round as applied only after the completion notification (`functionsExecutedState`) of the same round: the worker executes "result → per-sheet write-backs → completion notification" in this order and `postMessage` preserves it.
- A regression test with a result spanning at least two worksheets in Worker mode would cover this; main-thread tests cannot catch it because all write-backs happen synchronously there.
