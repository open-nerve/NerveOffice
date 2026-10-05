# UR-033 面板的防抖丢修改：数据验证详情面板的范围、设置、选项三种更新共用一个 1 秒的防抖，1 秒内先后改两种时前一种被丢掉；批注浮层（300 ms）与数据验证面板（1 秒）卸载时既不 flush 也不取消，关掉之后才写进模型、实例在这段时间里销毁时丢失

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue（两部分同一个根源：面板的写入经防抖、没有"立即提交"；也可以拆成两份，见跟踪表"提交之前要确认的事"）
> 出处：M3-P4 S4 对面板防抖的核实（P4 设计 `docs/v0.1/M3-编辑权与保存协议/04-P4-自动保存与打开自检.md` §3.4 的"实施"；"三种更新共用一个、前一种被丢"当时只按源码核实，列为规避的盲区）；ADR-010"M3-P4 的补充"的"捕获时机的接线"；内部 API 登记 `PANEL_DEBOUNCES`（`apps/web/src/editor/internal-api/panel-debounces.ts` 与 `registry.ts`）；平台的规避 `apps/web/src/editor/panel-debounce-watch.ts`（面板开着时记下输入，退出编辑、交出、按保存与失去编辑权的捕获之前等 SDK 的防抖到点），回归 E2E `tests/e2e/specs/editor/autosave.spec.ts`"面板的防抖"两条（批注里键入、数据验证面板里改数值之后立即退出编辑，服务器上有这次的改动）
> 发现版本：1.0.1｜1.0.1 发布包的代码：`@univerjs/sheets-data-validation-ui@1.0.1` `lib/es/index.js` 的 `debounceExecuteFactory` 与详情面板（三个更新函数共用它、卸载时不 flush），`@univerjs/ui@1.0.1` `lib/es/index.js` 的 `useDebounceFn`，`@univerjs/sheets-note-ui@1.0.1` `lib/es/index.js` 的批注浮层（`updateNote`），`@univerjs/core@1.0.1` 转出的 lodash-es `debounce`｜1.0.0 源码：相同（本地参考 `refer/univer` 是 v1.0.0；1.0.2 与 `dev` 没有核对）｜发布包上的复现：2026-10-06 在只用 SDK 的最小页面上复现，两部分都复现了（Playwright 1.63.0 的 Chromium 153.0.8010.12 与 WebKit 26.6，无头，结果相同；下文的代码与步骤）：数据验证面板 1 秒内先点"Allow blank values"再点"Reject input"，规则里只有后一个改动、面板上两个都显示已改，关掉再打开面板复选框回到原值，顺序反过来丢的是前一个；改完立即点"Done"，规则当时不变、约 1 秒后才变；改完立即销毁实例，改动丢失、1 秒后控制台出现命令被跳过的警告；下拉列表的规则先取消"Allow blank values"、1 秒内再把类型改成"Dropdown-Multiple"，类型改了、取消"允许空白"丢了；批注浮层键入之后立即 `save()` 里没有这段文字、400 ms 后才有，键入之后马上点别的格关掉浮层也一样（浮层已卸载，400 ms 后文字才写进去），键入之后立即销毁实例，文字丢失、300 ms 后同样的警告；范围的更新没有在页面上试（按源码与设置、选项走同一个防抖）

## 摘要（中文）

两部分：

1. **数据验证详情面板丢更新（缺陷）**：sheets-data-validation-ui 的详情面板（`DataValidationDetail`）把三种更新交给同一个防抖的执行函数（core 转出的 lodash `debounce`，1000 ms，到点只执行最后一次调用）：范围（`UpdateSheetDataValidationRangeCommand`）、设置（运算符、公式、"允许空白"：`UpdateSheetDataValidationSettingCommand`）、选项（出错时的样式、提示：`UpdateSheetDataValidationOptionsCommand`）。1 秒内先后改了两种时，只有后一种的命令被执行，前一种被丢掉；面板的本地状态两处都显示已改，模型里只有一处，关掉再打开面板（或撤销、重做）才露出模型里的值——用户的修改被静默丢弃。类型的修改不经防抖、立即执行，而且新的本地状态从模型里的规则算起，模型里还没有排着的修改：下拉列表的规则先取消"允许空白"、1 秒内再把类型改成"多选下拉"，类型改了，取消"允许空白"丢了（复选框跳回勾选）。
2. **卸载时既不 flush 也不取消**：数据验证面板（1 秒）与批注浮层（sheets-note-ui 的 `SheetsNote`，用 ui 的 `useDebounceFn`，300 ms）关闭、卸载时，挂起的更新既不立即执行，也不取消。实例还在时，它在卸载之后才写进模型——关掉面板之后马上 `save()` 拿到的是旧值；实例在这段时间里被销毁时，更新丢失，计时器到点时只打一条"命令服务已销毁、跳过"的警告。SDK 也没有对外的"立即提交面板里的修改"可以调用。

对平台的影响：退出编辑、失去编辑权都会销毁编辑器（阅读与编辑之间一律重建），自动保存与交出也要在捕获之前拿到最后的修改。S4 的规避：两个面板开着时在捕获阶段记下页头以外的输入事件，到点＝最后一次输入加 SDK 的时长再加 20 ms，捕获与销毁之前先等到这一刻（登记 `PANEL_DEBOUNCES`，SDK 改了时长时 E2E 会报出来）。第 1 部分平台无法规避：用户在 1 秒内先后改两种设置时，前一种在 SDK 里就丢了，平台存下的是 SDK 模型里的规则。

## 已有的上游讨论

- 没有检索：本次只用本地资源（本地参考源码与 1.0.1 发布包），不访问网络。【待补充：提交之前检索一次，建议的关键词：`debounceExecute data validation`、`DataValidationDetail debounce`、`data validation panel lost change`、`useDebounceFn unmount`、`note popup debounce dispose`、`update-data-validation-options skipped`】

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Panels lose edits through their debounces: the data validation panel sends range, setting and option updates through one 1-second debounce (an earlier change is dropped when another kind follows within a second), and neither that panel nor the note popup flushes its pending update when it unmounts

### Describe the bug

**1. The data validation panel drops updates.** `DataValidationDetailInner` (`@univerjs/sheets-data-validation-ui`) creates one debounced executor — lodash `debounce` (re-exported by `@univerjs/core`) with a 1000 ms wait around `commandService.executeCommand(id, params)` — and sends three different commands through it:

- range changes: `UpdateSheetDataValidationRangeCommand`;
- setting changes (operator, formulas, "Allow blank values"): `UpdateSheetDataValidationSettingCommand`;
- option changes (error style, help text): `UpdateSheetDataValidationOptionsCommand`.

A debounced function runs once, with the arguments of its last call. So when two different kinds of changes are made within one second, only the command of the last one is executed and the earlier change is silently dropped. The panel's local state shows both changes; after closing and reopening the panel, the dropped one is gone.

A type change is not debounced: it is executed immediately and the new local state is derived from the rule in the model, which does not contain the pending change yet. With a dropdown rule, unchecking "Allow blank values" and then switching the type to "Dropdown-Multiple" within a second keeps the new type but loses the unchecking (the checkbox flips back).

**2. Pending updates are neither flushed nor cancelled on unmount.** The data validation panel never calls `flush()` (or `cancel()`) on its debounced executor, and the note popup (`SheetsNote` in `@univerjs/sheets-note-ui`) uses `useDebounceFn()` from `@univerjs/ui` (300 ms), which keeps its timer in a ref and has no cleanup. Right after the panel or popup has been closed, the model — and therefore `workbook.save()` — does not contain the last edit yet; it is applied up to 1 s / 300 ms later by a component that no longer exists. If the Univer instance is disposed in that window (e.g. the host closes the editor), the edit is lost and the late call only logs `command "…" skipped because CommandService is disposed.` There is no API a host could call to commit pending panel edits before saving or disposing.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接；下面的代码与步骤已经在本地用 1.0.1 跑过】

A page with the sheet UI, data validation and notes (we registered `UniverRenderEnginePlugin`, `UniverUIPlugin({ container: 'app' })`, `UniverDocsPlugin`, `UniverDocsUIPlugin`, `UniverFormulaEnginePlugin`, `UniverSheetsPlugin`, `UniverSheetsUIPlugin`, `UniverSheetsFormulaPlugin`, `UniverSheetsFormulaUIPlugin`, `UniverDataValidationPlugin`, `UniverSheetsDataValidationPlugin`, `UniverSheetsDataValidationUIPlugin`, `UniverSheetsNotePlugin`, `UniverSheetsNoteUIPlugin`, with their CSS and en-US locales), and this workbook — a "decimal between 1 and 10" rule on A1:A5 that allows blanks and shows a warning:

```js
const workbook = univerAPI.createWorkbook({
    id: 'wb',
    sheetOrder: ['s1'],
    sheets: { s1: { id: 's1', name: 'Sheet1', cellData: { 0: { 0: { v: 5 } } } } },
    resources: [{
        name: 'SHEET_DATA_VALIDATION_PLUGIN',
        data: JSON.stringify({
            s1: [{ uid: 'dv1', type: 'decimal', operator: 'between', formula1: '1', formula2: '10', allowBlank: true, errorStyle: 2 /* WARNING */, ranges: [{ startRow: 0, endRow: 4, startColumn: 0, endColumn: 0 }] }],
        }),
    }],
});
const resource = (name) => JSON.parse(workbook.save().resources?.find((r) => r.name === name)?.data ?? '{}');
const rule = () => { const { allowBlank, errorStyle } = resource('SHEET_DATA_VALIDATION_PLUGIN').s1[0]; return { allowBlank, errorStyle }; };
const note = () => resource('SHEET_NOTE_PLUGIN').s1?.[2]?.[2]?.note ?? null; // the note of C3
const openPanel = () => univerAPI.executeCommand('data-validation.operation.open-validation-panel', { ruleId: 'dv1' });
const openNote = () => { workbook.getActiveSheet().getRange('C3').activate(); return univerAPI.executeCommand('sheet.operation.add-note-popup'); };
```

(We waited for the Steady stage before the steps; the clicks were made with Playwright, within well under a second of each other.)

A. Two kinds of updates in the data validation panel:

1. `openPanel()`, then click "Advance options" to expand the options.
2. Click "Allow blank values" (unchecks it), then within a second click "Reject input".
3. After 1.5 s, `rule()` and the checkbox in the panel; then click "Done", `openPanel()` again and look at the checkbox.
4. Repeat with the opposite order: "Reject input" first, then "Allow blank values".

B. Closing the data validation panel right after a change:

1. `openPanel()`, expand "Advance options", click "Reject input", click "Done" right away.
2. `rule()` as soon as the panel is gone, and again 1.2 s later.
3. Repeat, but call `univer.dispose()` right after clicking "Reject input".

C. The note popup:

1. `await openNote()`, wait 0.5 s (opening the popup writes the initial empty note through the same 300 ms debounce), click into the popup and type `remember`.
2. `note()` right after typing, and again 400 ms later.
3. Repeat, but right after typing click a cell that has no note (E8), which hides and unmounts the popup: `note()` as soon as the popup is gone, and again 400 ms later.
4. Repeat, but call `univer.dispose()` right after typing.

D. A type change after a setting change (same page, but the rule is a dropdown: `{ uid: 'dv1', type: 'list', formula1: 'a,b,c', allowBlank: true, errorStyle: 2, ranges: [/* A1:A5 */] }`):

1. `openPanel()`, click "Allow blank values" (unchecks it).
2. Within a second, open the "Type" select and choose "Dropdown-Multiple".
3. Read `type`, `formula1`, `formula2` and `allowBlank` of the rule from `workbook.save()` 0.1 s and 1.6 s later, and look at the checkbox.

### Expected behavior

- A: both changes reach the rule (`allowBlank: false`, `errorStyle: 1` /* STOP */), whatever the order.
- D: the rule ends as `type: 'listMultiple'` with `allowBlank: false`.
- B, C: closing the panel or the popup commits the pending edit, so `save()` right afterwards contains it; and there is a way for the host to commit pending edits before `univer.dispose()`.

### Actual behavior

Chromium 153 and WebKit 26.6 give the same results:

```text
A  rule before:                                   {"allowBlank":true,"errorStyle":2}
   clicked "Allow blank values", then "Reject input"
   rule 1.5 s later:                              {"allowBlank":true,"errorStyle":1}    <- allowBlank change dropped
   panel checkbox "Allow blank values" checked:   false
   after "Done" and reopening the panel:          true
   opposite order, rule 1.5 s later:              {"allowBlank":false,"errorStyle":2}   <- errorStyle change dropped

B  panel closed with "Done"; rule right away:     {"allowBlank":true,"errorStyle":2}
   rule 1.2 s later:                              {"allowBlank":true,"errorStyle":1}
   with univer.dispose() instead of "Done", when the 1 s debounce fires:
   [CommandService] command "sheets.command.update-data-validation-options" skipped because CommandService is disposed.

C  note right after typing:                       ""
   note 400 ms later:                             "remember"
   popup closed by clicking E8; note right away:  ""
   note 400 ms later:                             "remember"
   with univer.dispose() right after typing, when the 300 ms debounce fires:
   [CommandService] command "sheet.command.update-note" skipped because CommandService is disposed.

D  rule before:                                   {"type":"list","formula1":"a,b,c","allowBlank":true}
   checkbox after clicking "Allow blank values":  unchecked
   rule 0.1 s after choosing "Dropdown-Multiple": {"type":"listMultiple","formula1":"a,b,c","allowBlank":true}
   rule 1.6 s after:                              {"type":"listMultiple","formula1":"[\"a\",\"b\",\"c\"]","formula2":",,","allowBlank":true}   <- unchecking lost
   checkbox "Allow blank values":                 checked again
```

### Root cause analysis

Paths are relative to the repository root, at tag v1.0.0 (the same code is in the published 1.0.1 packages).

- `packages/sheets-data-validation-ui/src/views/components/DataValidationDetail.tsx`:
  - `debounceExecuteFactory()` wraps `commandService.executeCommand(id, params, options)` in `debounce(…, 1000)`;
  - `DataValidationDetailInner` creates one executor with `useMemo` and calls it from `handleUpdateRuleRanges` (range), `handleUpdateRuleSetting` (operator, formula inputs, "Allow blank values") and `handleUpdateRuleOptions` (the `DataValidationOptions` component) with different command ids, so a later call of another kind replaces the pending one;
  - none of its effects flushes or cancels the executor on unmount; "Done" (`handleOk`) only closes the panel;
  - `handleChangeType` executes `UpdateSheetDataValidationSettingCommand` immediately and builds the new local rule from `dataValidationModel.getRuleById()` (for the same type or list ↔ list-multiple) or from the local rule with the formulas reset, without looking at the pending debounced call; in D the immediate update already carries the model's `allowBlank: true`, and the later setting update seen 1.6 s later (the options editor of the new type rewrites `formula1`/`formula2` through `handleUpdateRuleSetting`, i.e. the same debounce) replaces the pending "Allow blank values" update.
- `packages/core/src/common/lodash.ts` re-exports `debounce` from lodash-es (trailing call with the last arguments).
- `packages/ui/src/views/hooks/use-debounce.ts`, `useDebounceFn()`: keeps the timer in a `useRef`, clears it only on the next call, has no unmount cleanup and no `flush`.
- `packages/sheets-note-ui/src/views/Note.tsx`, `SheetsNoteContent`: `updateNote = useDebounceFn(…)` executes `SheetUpdateNoteCommand` for text changes, size changes and the initial empty note.
- `packages/core/src/services/command/command.service.ts`: after disposal `executeCommand()` / `syncExecuteCommand()` log the "skipped because CommandService is disposed" warning and return `false`, so a late debounced call is lost.

### Suggested fix

1. In `DataValidationDetailInner`, keep updates of different kinds from replacing each other: one debounced executor per command (range, setting, options), or merge the pending changes into a single rule update; and flush pending updates before executing a command immediately (the type change).
2. Commit pending edits when the component goes away: e.g. `useEffect(() => () => debounceExecute.flush(), [debounceExecute])` in `DataValidationDetailInner` (and in `handleOk`), and give `useDebounceFn()` an unmount cleanup plus a `flush()` that the note popup calls when it is hidden.
3. Optionally, a way for hosts to commit pending UI edits before `save()` or `dispose()` (a command, or flushing open panels when the unit or the instance is disposed while the command service still accepts commands).

### Environment

- Univer: 1.0.1 (`@univerjs/*`); the same code is in 1.0.0. Affected packages: `@univerjs/sheets-data-validation-ui`, `@univerjs/sheets-note-ui`, `@univerjs/ui` (`useDebounceFn`).
- Browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, headless (page served by Vite 8.3.0, React 19.3.0, lodash-es 4.18.1).
- OS: macOS 27.0 (Apple silicon).
