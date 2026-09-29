# UR-005 被 `BeforeCommandExecute` 取消的命令留在执行栈里，之后在命令之外执行的 mutation 带上它的 `trigger`

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue（引用未合并的 PR #7455；也可以改为在 #7455 下补充影响与复现，见"已有的上游讨论"）
> 出处：延期登记 DEF-020（`docs/v0.1/02-延期事项登记.md`）；M1-P4 设计 §7"S2 探针的结论"第 5 条（`docs/v0.1/M1-工程底座与行走骨架/04-P4-编辑器接入与在线保存.md`）；P4 交接单与 P4 审查报告的延期项；入口守卫 `apps/web/src/editor/profile/entry-guards.ts`；M2-P3 审查 A5（被权限检查拦下的命令同样留在栈里，发布包 `@univerjs/sheets@1.0.1` `lib/es/index.js` 第 18114–18117、18129–18132 行）｜发现版本：1.0.1｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/core@1.0.1` `lib/es/index.js` 第 2175–2254 行（压栈在前、只在成功路径上出栈，没有 `finally`）、第 2282–2291 行（`_attachMutationTrigger`），`lib/es/facade.js` 第 1242–1275 行（取消时抛 `CanceledError`）；2026-09-28 用 1.0.1 发布包在 Node.js 上复现（下文的脚本与输出）；1.0.0 源码相同；GitHub 上 `dev` 分支（2026-09-28）也没有改

## 摘要（中文）

命令服务在调用 `beforeCommandExecuted` 监听之前就把命令压进执行栈，只在成功路径上释放。Facade 的 `BeforeCommandExecute`、`BeforeUndo`、`BeforeRedo` 取消命令的方式是在监听里抛出 `CanceledError`，命令服务捕获后返回 `false`，但栈项没有释放，会在实例的整个生命周期里一直留着。被 SDK 自己的权限检查拦下的命令同样如此：sheets 的 `SheetPermissionCheckController` 也是在 `beforeCommandExecuted` 监听里抛出 `CustomCommandExecutionError`（`blockExecuteWithoutPermission`），所以只读的工作簿里每一次被拦下的键入、粘贴、改格式都会在栈里留下一项（M2-P3 审查 A5）。之后在任何命令之外执行的 mutation（公式计算的开始、进度与完成通知、结果与结果写回等）都会在 `trigger` 里带上这个早已取消的命令 id；留下的是 COMMAND（例如被取消的撤销）时，连 mutation 已有的 `trigger` 也会被覆盖。M1-P4 的探针（1.0.1）在 Ctrl/Cmd+K 被入口守卫取消之后，看到公式的开始与完成通知带 `sheet.operation.insert-hyper-link-toolbar`；2026-09-28 用 1.0.1 在 Node.js 上复现了"取消一次操作"与"取消一次撤销"两种情形，并确认留下的 COMMAND 会覆盖已有的 `trigger`。SDK 自己有按 `trigger` 做判断的地方（例如公式是否因一次写入而重算、自动填充界面是否退出），但我们没有观察到功能上的影响。平台目前不受影响：变更检测与公式收齐都不看 `trigger`；M3 若要按 `trigger` 区分来源，需要先规避（DEF-020）。上游有一个未合并的 PR #7455 顺带修了这一点，并带有针对这一情形的测试。

## 已有的上游讨论

- [#7455](https://github.com/dream-num/univer/pull/7455) feat(core): add result-aware command completion hook —— **打开、未合并**（2026-08-09 创建，最后更新 2026-08-11）。这个 PR 的主要目的是新增 `onCommandExecutionCompleted` 钩子，但它把 `executeCommand` / `syncExecuteCommand` 的执行放进 `try … finally { stackItemDisposable.dispose() }`，并新增测试 "Should report a before-listener rejection and remove its command from the trigger stack"（断言之后的 mutation `params.trigger` 为 `undefined`）。合并后会修复本问题。
- 没有找到对应的 issue（2026-09-28 检索）。检索用的关键词：`BeforeCommandExecute`、`CanceledError`、`commandExecutionStack`、`attachMutationTrigger`、`"execution stack"`、`mutation trigger in:title`、`is:pr is:open command service`（GitHub 搜索接口），以及网页搜索"dream-num univer BeforeCommandExecute cancel command execution stack trigger"。
- 相关但不同的问题：[#4995](https://github.com/dream-num/univer/issues/4995)（取消 `BeforeSheetEditStart` 时控制台报未捕获的 `CanceledError`，2025-04-14 以 not planned 关闭）；[#583](https://github.com/dream-num/univer/pull/583)（2023 年给 mutation 加上 `trigger` 参数）。
- 提交方式需要需求方决定：新开 issue（正文引用 #7455，请求合并或单独落地这一部分），或者只在 #7455 下留言补充影响与复现。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] A command cancelled via `BeforeCommandExecute` / `BeforeUndo` stays on the command execution stack, and its id leaks into the `trigger` of later mutations

### Describe the bug

`CommandService.executeCommand()` and `syncExecuteCommand()` push the command onto `_commandExecutionStack` **before** calling the `beforeCommandExecuted` listeners, and remove it only on the success path. The Facade cancels a command by throwing `CanceledError` from those listeners (`BeforeCommandExecute`, `BeforeUndo`, `BeforeRedo`); the command service catches it and returns `false`, but the stack item is never disposed. It stays on the stack for the lifetime of the Univer instance, one entry per cancellation.

The same happens to commands rejected by Univer's own permission check: `SheetPermissionCheckController` (`@univerjs/sheets`) also throws a `CustomCommandExecutionError` from a `beforeCommandExecuted` listener (`blockExecuteWithoutPermission()`), so in a non-editable workbook every blocked keystroke, paste or formatting shortcut leaves an item on the stack.

`_attachMutationTrigger()` looks the trigger up on that stack. From then on, every mutation executed outside a command — formula calculation start/progress/completion notifications, the calculation result and its write-backs, and so on — gets the id of the long-cancelled command as its `trigger`. If the stale item is a COMMAND (e.g. a cancelled undo), it even overwrites a `trigger` the mutation already had.

We found it while cancelling Ctrl/Cmd+K: after a `BeforeCommandExecute` listener cancelled `sheet.operation.insert-hyper-link-toolbar`, the formula calculation start and completion notifications carried `trigger: 'sheet.operation.insert-hyper-link-toolbar'`.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的仓库或 StackBlitz（Node 模板）链接；下面的脚本已经在本地用 1.0.1 跑过】

In the UI: with `@univerjs/sheets-hyper-link-ui`, add a `BeforeCommandExecute` listener that sets `event.cancel = true` for `sheet.operation.insert-hyper-link-toolbar`, press Ctrl/Cmd+K in a cell, then edit a cell referenced by a formula and log the `trigger` of the formula mutations.

Minimal example with public APIs only (Node.js; the same calls work in a browser). Any command or operation id can be cancelled; the script uses one that is always registered:

```js
// node repro.cjs [none|operation|undo]
const { CommandType, LocaleType, LogLevel, Univer, UniverInstanceType } = require('@univerjs/core');
const { FUniver } = require('@univerjs/core/facade');
const { UniverSheetsPlugin } = require('@univerjs/sheets');
const { UniverFormulaEnginePlugin } = require('@univerjs/engine-formula');
const { UniverSheetsFormulaPlugin } = require('@univerjs/sheets-formula');
require('@univerjs/sheets/facade');
require('@univerjs/engine-formula/facade');
require('@univerjs/sheets-formula/facade');

async function main() {
    const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} }, logLevel: LogLevel.WARN });
    univer.registerPlugin(UniverSheetsPlugin);
    univer.registerPlugin(UniverFormulaEnginePlugin);
    univer.registerPlugin(UniverSheetsFormulaPlugin);
    univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
        id: 'wb',
        sheetOrder: ['s1'],
        sheets: { s1: { id: 's1', name: 'Sheet1', rowCount: 100, columnCount: 10, cellData: { 0: { 0: { v: 1 }, 1: { f: '=A1*2' } } } } },
    });
    const univerAPI = FUniver.newAPI(univer);
    const formula = univerAPI.getFormula();
    const wb = univerAPI.getActiveWorkbook();
    await formula.onCalculationResultApplied(10000);

    const variant = process.argv[2] ?? 'operation';
    if (variant === 'operation') {
        // Cancel one operation through the public BeforeCommandExecute event (any command or operation id leaks the same way).
        univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
            if (event.id === 'sheet.operation.set-selections') event.cancel = true;
        });
        console.log('cancelled:', await univerAPI.executeCommand('sheet.operation.set-selections', { unitId: 'wb', subUnitId: 's1', type: 0, selections: [] }));
    } else if (variant === 'undo') {
        // Cancel an undo through the public BeforeUndo event.
        wb.getActiveSheet().getRange('C1').setValue('x');
        univerAPI.addEvent(univerAPI.Event.BeforeUndo, (event) => { event.cancel = true; });
        console.log('cancelled:', await univerAPI.undo());
    }

    univerAPI.addEvent(univerAPI.Event.CommandExecuted, (e) => {
        if (e.type === CommandType.MUTATION) console.log(e.id, 'trigger =', e.params?.trigger);
    });
    wb.getActiveSheet().getRange('A1').setValue(21); // Sheet1!B1 is =A1*2
    await formula.onCalculationResultApplied(10000);
    console.log('B1 =', wb.getActiveSheet().getRange('B1').getValue());
    univer.dispose();
}

main();
```

### Expected behavior

A cancelled command leaves no trace: mutations executed afterwards outside any command keep `trigger === undefined` (as in the `none` run below), a `trigger` that a mutation already carries is kept, and the execution stack is empty again.

### Actual behavior

Output of the script above (Node.js 24.21.0, published 1.0.1 packages).

`node repro.cjs none` (baseline):

```text
sheet.mutation.set-range-values trigger = sheet.command.set-range-values
formula.mutation.set-formula-calculation-start trigger = undefined
formula.mutation.set-formula-calculation-notification trigger = undefined
(… 4 more progress notifications, trigger = undefined …)
formula.mutation.set-array-formula-data trigger = undefined
sheet.mutation.set-range-values trigger = undefined
formula.mutation.set-formula-calculation-result trigger = undefined
formula.mutation.set-formula-calculation-notification trigger = undefined
B1 = 42
```

`node repro.cjs operation`:

```text
cancelled: false
sheet.mutation.set-range-values trigger = sheet.command.set-range-values
formula.mutation.set-formula-calculation-start trigger = sheet.operation.set-selections
formula.mutation.set-formula-calculation-notification trigger = sheet.operation.set-selections
(… 4 more progress notifications, same trigger …)
formula.mutation.set-array-formula-data trigger = sheet.operation.set-selections
sheet.mutation.set-range-values trigger = sheet.operation.set-selections
formula.mutation.set-formula-calculation-result trigger = sheet.operation.set-selections
formula.mutation.set-formula-calculation-notification trigger = sheet.operation.set-selections
B1 = 42
```

`node repro.cjs undo` gives the same list with `trigger = univer.command.undo`, including the formula write-back `sheet.mutation.set-range-values`. Inspecting the private `_commandExecutionStack` after the cancellation shows `["sheet.operation.set-selections"]` and `["univer.command.undo"]` respectively, and the entry is still there at the end of the run.

With a cancelled undo on the stack, a mutation executed outside a command that already carries `trigger: 'sheet.command.set-style'` is reported with `trigger: 'univer.command.undo'`; with a cancelled operation on the stack, its own trigger is kept (checked with `univerAPI.syncExecuteCommand('sheet.mutation.set-range-values', { …, trigger: 'sheet.command.set-style' }, { onlyLocal: true })`).

In the browser (1.0.1; our probe ran in Chromium, Chrome and WebKit driven by Playwright), after cancelling `sheet.operation.insert-hyper-link-toolbar` (Ctrl/Cmd+K) the formula calculation start and completion notifications carried `trigger: 'sheet.operation.insert-hyper-link-toolbar'`. We have not observed a functional failure caused by the wrong triggers.

### Root cause analysis

Paths are relative to the repository root; line numbers refer to tag v1.0.0 (the same code is in 1.0.1).

- `packages/core/src/services/command/command.service.ts`
  - `executeCommand()` L416-475: L438 pushes the stack item, L441 calls the `beforeCommandExecuted` listeners, L461 disposes the item only after a successful execution; the `catch` at L467-474 returns `false` for a `CustomCommandExecutionError` without disposing it. `syncExecuteCommand()` L477-535 has the same structure (L499, L502, L522, L528-534). By code reading, a handler that throws leaks its stack item the same way.
  - `_attachMutationTrigger()` L576-601: for every mutation, `findLast` on the stack picks the stale item; a stale COMMAND overwrites `params.trigger` unconditionally (L581-588), a stale OPERATION fills it in when it is missing (L590-600).
- `packages/core/src/facade/f-univer.ts` L217-273: `BeforeRedo`, `BeforeUndo` and `BeforeCommandExecute` cancel by throwing `CanceledError` (L231, L249, L267), which extends `CustomCommandExecutionError` (`packages/core/src/common/error.ts` L17-29).
- `packages/sheets/src/controllers/permission/sheet-permission-check.controller.ts` L178-183 and L207-210: the permission check runs in a `beforeCommandExecuted` listener and rejects a command by throwing `CustomCommandExecutionError('have no permission')`, taking the same path.
- Mutations executed outside commands, e.g. the calculation start in `packages/engine-formula/src/services/formula-calculation-trigger.service.ts` L147-158 and the completion notification in `packages/engine-formula/src/controllers/calculate.controller.ts` L247-255, therefore pick up the stale trigger.
- Code that reads `trigger` includes `packages/sheets-formula/src/controllers/active-dirty.controller.ts` L79-85 (whether a `SetRangeValuesMutation` triggers recalculation) and `packages/sheets-ui/src/controllers/auto-fill-ui.controller.ts` L158-171.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.1, the same code is in 1.0.0 and on `dev` (checked on 2026-09-28). Affected package: `@univerjs/core`.
- Browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, and Google Chrome 153, all headless, driven by Playwright 【待补充：探针那次运行的 Chrome 具体版本没有记录；本机当前安装的是 153.0.8010.53】. The minimal example runs without a browser: Node.js 24.21.0.
- OS: macOS (Apple silicon) 【待补充：探针那次运行时的 macOS 版本没有记录】; the Node.js run was on macOS 27.0 (arm64).

### Suggested fix

Dispose the stack item in a `finally` block, in both `executeCommand()` and `syncExecuteCommand()`:

```ts
const stackItemDisposable = this._pushCommandExecutionStack(commandInfo);
try {
    this._beforeCommandExecutionListeners.forEach((listener) => listener(commandInfo, _options));
    // … execute and notify as today …
    return result;
} finally {
    stackItemDisposable.dispose();
}
```

The open PR #7455 already contains this change together with the test "Should report a before-listener rejection and remove its command from the trigger stack"; landing that part on its own would fix this issue.
