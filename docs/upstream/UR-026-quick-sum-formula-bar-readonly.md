# UR-026 快速求和不看单元格编辑器有没有打开，直接往编辑器里写公式：工作簿不可编辑时编辑栏一直显示文档里没有的公式

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M2-P6 第 4 片复核 F2（`docs/v0.1/M2-组织空间与权限/reviews/P6-S4-编辑器只读.md`）；平台的规避 `apps/web/src/editor/read-only/read-only-guard.ts` 的 `READ_ONLY_GUARDED_COMMANDS`（只读时在执行前取消 `formula-ui.operation.insert-function`），E2E `tests/e2e/specs/editor/read-only.spec.ts`"快速求和"（能编辑时作对照：编辑栏显示 `=SUM(B2:B9`）与 `tests/e2e/specs/editor/read-only-shortcuts.spec.ts`（每按一个快捷键都核对编辑栏与这一格的真实内容一致）｜发现版本：1.0.1｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/sheets-formula-ui@1.0.1` `lib/es/index.js` 的 `InsertFunctionOperation`（打开单元格编辑器、不看结果，接着往单元格编辑器与编辑栏的内部文档写公式；取了 `IEditorBridgeService` 却没有用）、`QuickSumShortcut`（快捷键）、`InsertCommonFunctionMenuItemFactory` 与 `createInsertFunctionCategoryMenuItemFactory`（功能区"公式"页的插入函数菜单，没有 `disabled$`）、`MoreFunctions` 的 `handleConfirm`（"更多函数"面板的确认，同样不看结果）；`@univerjs/sheets-ui@1.0.1` `lib/es/index.js` 的 `SheetPermissionCheckUIController._getPermissionCheck`（打开单元格编辑器时的权限检查）；`@univerjs/sheets@1.0.1` `lib/es/index.js` 的 `SheetPermissionCheckController.blockExecuteWithoutPermission`（弹出提示、抛出 `CustomCommandExecutionError`）；`@univerjs/core@1.0.1` `lib/es/index.js` 的 `CommandService.syncExecuteCommand`（接住它、返回 `false`）；`@univerjs/docs-ui@1.0.1` `lib/es/index.js` 的 `Editor.replaceText`（经 `doc.command-replace-snapshot` 换掉编辑器的内部文档）；复核时 Chromium、WebKit 的截图一致；1.0.0 源码相同（本地参考 `refer/univer` 是 v1.0.0；1.0.2 与 `dev` 没有核对）

## 摘要（中文）

工作簿不可编辑（`WorkbookEditablePermission` 为假，没有保护规则，平台的查看者就是这样）时，选中一个空单元格按快速求和（Alt+=，苹果的平台上 Cmd+Option+=）：快速求和的操作 `formula-ui.operation.insert-function` 先执行"打开单元格编辑器"（`sheet.operation.set-cell-edit-visible`），被权限检查拦下、弹出权限提示（SDK 的说法是"该范围已被保护，目前无编辑权限……"，平台改成了"只能查看，不能修改"）；但它不看这一步的结果，接着把 `=SUM(B2:B9` 写进单元格编辑器与编辑栏的内部文档（`doc.command-replace-snapshot`）。关掉提示之后，编辑栏一直显示这个公式，像是这一格里有它，直到选区移开、编辑栏按模型重新同步。工作簿本身不变：写的是编辑器的内部文档。

影响：查看者会误以为单元格里有这个公式，界面显示的与文档不一致（与 UR-022"冻结线拖完停在原处"同一个标准，复核时主会话把它升为必须修）。按源码另有两处同样的情况（都没有试）：功能区"公式"页的插入函数菜单执行的是同一个操作，菜单项没有 `disabled$`，不可编辑时从那里选 SUM 应当是同样的结果（平台只读时关掉了工具栏）；"更多函数"面板的确认（`MoreFunctions.tsx` 的 `handleConfirm`）也是不看结果就写编辑器，不过它的菜单项在不可编辑时是停用的。

平台的规避：只读时在执行前取消 `formula-ui.operation.insert-function`（只读守卫的 `READ_ONLY_GUARDED_COMMANDS`），代价是只读时快速求和的快捷键没有反应（求和本来就是编辑）。E2E 核对只读时按快速求和，编辑栏仍是这一格的真实内容、没有提示、内容不变；能编辑时同样的按法编辑栏显示 `=SUM(B2:B9`、回车写入（对照）。快捷键的回归每按一个快捷键都核对编辑栏与这一格的真实内容一致，SDK 升级之后有同类的入口也能发现。

## 已有的上游讨论

- 没有检索：2026-10-02 起只用本地资源（本地参考源码与 1.0.1 发布包），不访问网络。【待补充：提交之前检索一次，建议的关键词：`quick sum permission`、`insert-function readonly`、`InsertFunctionOperation`、`formula bar shows formula`、`Alt+= protected`】

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Quick Sum writes `=SUM(…` into the cell editor and the formula bar without checking that the cell editor opened; in a non-editable workbook the formula bar keeps showing a formula that is not in the cell

### Describe the bug

`InsertFunctionOperation` (`formula-ui.operation.insert-function`, the Quick Sum shortcut Alt+=, Cmd+Option+= on macOS) handles a single selected cell by opening the cell editor and filling in `=SUM(<range>`:

1. it executes `sheet.operation.set-cell-edit-visible` with `visible: true`;
2. it calls `replaceText()` on the cell editor and on the formula bar editor.

The result of step 1 is ignored. When the cell editor cannot be opened, for example because the workbook is not editable, `SheetPermissionCheckUIController` rejects step 1: it shows the permission alert and throws `CustomCommandExecutionError`, which `syncExecuteCommand()` turns into `false`. Step 2 still runs. The formula bar's internal document now contains `=SUM(B2:B9`, while the cell editor is closed and the cell is still empty. After the alert is closed, the formula bar keeps showing that formula until the selection changes and the formula bar is re-synced from the model. The workbook itself is not changed.

To a viewer this looks as if the cell contains `=SUM(B2:B9`.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接；下面是最小的配置】

1. Create a workbook with numbers in B2:B9 and an empty B10, and make it non-editable without protection rules, e.g. override `IAuthzIoService` so that `allowed()` returns `false` for `UnitAction.Edit` (and `true` for `View`/`Copy`).
2. Select B10 and press Alt+= (Cmd+Option+= on macOS).
3. The permission alert appears ("The range is protected, and you do not have edit permission. …"). Close it.
4. The formula bar shows `=SUM(B2:B9`, although B10 is empty. Select another cell and then B10 again: the formula bar shows B10's real (empty) content.

### Expected behavior

If the cell editor does not open, Quick Sum stops after the permission alert and leaves the editors untouched; the formula bar keeps showing the cell's real content.

### Actual behavior

The formula bar shows `=SUM(B2:B9` until the selection changes. `doc.command-replace-snapshot` (with its `doc.mutation.rich-text-editing`) is executed on the internal editor documents (`__INTERNAL_EDITOR__DOCS_NORMAL` and `__INTERNAL_EDITOR__DOCS_FORMULA_BAR`). We reproduced it in Chromium and WebKit.

### Root cause analysis

Paths are relative to the repository root, at tag v1.0.0 (the same code is in the published 1.0.1 packages).

- `packages/sheets-formula-ui/src/commands/operations/insert-function.operation.ts`: for a single cell the operation takes the edit-mode branch (`if (editRange)`). It executes `SetCellEditVisibleOperation` without looking at the return value, then writes the formula into both editors with `replaceText()`. `IEditorBridgeService` is fetched in the handler but never used.
- `packages/sheets-ui/src/controllers/permission/sheet-permission-check-ui.controller.ts`, `_getPermissionCheck()`: `set-cell-edit-visible` with `visible: true` is checked against `WorkbookEditablePermission`, `WorksheetSetCellValuePermission`, `WorksheetEditPermission` and range protection; on failure `SheetPermissionCheckController.blockExecuteWithoutPermission()` (`packages/sheets/src/controllers/permission/sheet-permission-check.controller.ts`) emits the event that opens the alert and throws `CustomCommandExecutionError`.
- `packages/core/src/services/command/command.service.ts`: `syncExecuteCommand()` catches `CustomCommandExecutionError` and returns `false`, so the operation continues.
- `packages/docs-ui/src/services/editor/editor.ts`: `replaceText()` replaces the editor's document through `setDocumentData()` and `ReplaceSnapshotCommand`, whether or not the editor is visible.
- The same pattern, by reading the code (not tried):
  - the Formulas-tab function menus (`InsertCommonFunctionMenuItemFactory` and the category menus built by `createInsertFunctionCategoryMenuItemFactory()` in `packages/sheets-formula-ui/src/menu/menu.ts`) run the same `InsertFunctionOperation` and have no `disabled$`, so choosing SUM there in a non-editable workbook should end the same way (we hide the toolbar in read-only mode);
  - `handleConfirm()` in `packages/sheets-formula-ui/src/views/more-functions/MoreFunctions.tsx` opens the cell editor with `executeCommand()` without awaiting or checking it and then calls `replaceText()` on both editors. Its menu item is disabled in a non-editable workbook (`AllFunctionsMenuItemFactory` in `menu/menu.ts`), so we could not reach it there.

### Suggested fix

In `InsertFunctionOperation`, stop when the cell editor did not open, for example:

```ts
const opened = commandService.syncExecuteCommand(SetCellEditVisibleOperation.id, {
    visible: true,
    unitId,
    eventType: DeviceInputEventType.Dblclick,
});
if (!opened || !editorBridgeService.isVisible().visible) {
    return false;
}
```

Do the same in `MoreFunctions.tsx` (await the command and check its result). Optionally, give the Formulas-tab function menus the same permission-based `disabled$` as "All functions".

### Environment

- Univer: 1.0.1 (`@univerjs/*`), same code in 1.0.0. Affected package: `@univerjs/sheets-formula-ui`.
- Browsers: Chromium and WebKit bundled with Playwright 1.63.0, headless, driven by Playwright (reproduced in both).
- OS: macOS 27.0 (Apple silicon).
