# UR-027 隐藏行列与冻结的命令没有权限检查：工作簿不可编辑时 Ctrl/Cmd+9、Ctrl/Cmd+Shift+0 与冻结照样执行，没有任何提示

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue（冻结部分与 UR-022 同源，提交时可以合并成一份）
> 出处：M2-P6 第 4 片复核（`docs/v0.1/M2-组织空间与权限/reviews/P6-S4-编辑器只读.md`）"实现者提出、主会话的决定"第 2 条（隐藏行列）与 F1（从"搜索功能"面板执行冻结）；平台没有专门的规避，靠只读守卫的防火墙（`apps/web/src/editor/read-only/read-only-guard.ts`）取消产生的 mutation，E2E `tests/e2e/specs/editor/read-only-shortcuts.spec.ts`（整行、整列选中时逐个按遍快捷键：Cmd+9、Cmd+Shift+0 走到隐藏行列的 mutation、被防火墙取消，内容不变）｜发现版本：1.0.1｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/sheets@1.0.1` `lib/es/index.js` 的 `SheetPermissionCheckController._getPermissionCheck`（检查了显示行列的四条命令，没有隐藏行列与冻结的条目）、`SetRowHiddenCommand` 与 `getSelectedRowRanges`（只取整行的选区）、`SetColHiddenCommand` 与 `getSelectedColRanges`（只取整列的选区）、`SetFrozenCommand`、`CancelFrozenCommand`；`@univerjs/sheets@1.0.1` `lib/es/facade.js` 里 `FWorksheet` 的 `hideRow`、`hideRows`、`hideColumn`、`hideColumns`（Facade 的隐藏行列）、`unhideRow`、`showRows`（显示行列，走有检查的命令）、`setFreeze`、`cancelFreeze`、`setFrozenColumns`、`setFrozenRows`（Facade 的冻结）；`@univerjs/sheets-ui@1.0.1` `lib/es/index.js` 的 `SetRowHiddenShortcutItem`、`SetColHiddenShortcutItem`（两个快捷键）、`HideRowMenuItemFactory`、`HideColMenuItemFactory`（右键菜单的隐藏行列按权限停用）、`SheetPermissionCheckUIController._getPermissionCheck`（界面层的权限检查只管文字输入、打开单元格编辑器与格式刷）、`SetSelectionFrozenCommand` 与委托给它的冻结命令（直接执行 mutation）、源文件 `src/menu/frozen.menu.ts` 那一段里的冻结菜单项（从 `SheetFrozenToolbarMenuItemFactory` 到 `CancelFrozenMenuItemFactory`，都没有 `disabled$`）；E2E 在 Chromium、Chrome、WebKit 上；1.0.0 源码相同（本地参考 `refer/univer` 是 v1.0.0；1.0.2 与 `dev` 没有核对）

## 摘要（中文）

工作簿不可编辑（`WorkbookEditablePermission` 为假，没有保护规则，平台的查看者就是这样）时：

1. **隐藏行列**：选中整行按 Ctrl/Cmd+9（`sheet.command.set-rows-hidden`），或选中整列按 Ctrl/Cmd+Shift+0（`sheet.command.set-col-hidden`），命令照常执行，直接走到 `sheet.mutation.set-row-hidden`、`sheet.mutation.set-col-hidden`，没有任何提示。平台的防火墙取消了 mutation，内容不变，看起来就是"按了没反应"；按源码，没有防火墙的集成方，行列会被隐藏（还进了撤销栈）。SDK 自己的检查（`SheetPermissionCheckController`）列了显示行列的四条命令，却没有隐藏的这两条；按源码，右键菜单里的"隐藏行""隐藏列"在不可编辑时是停用的，"显示行列"也会被拦下——于是没有防火墙时，查看者能藏起行列，却显示不回来。只选中单元格时这两个命令直接返回 `false`：能编辑时也是这样（SDK 的隐藏快捷键只作用于整行、整列的选区），与权限无关。按源码，Facade 的 `hideRows()`、`hideColumns()` 等同样不受检查，而 `showRows()` 会被拦下（没有试）。
2. **冻结**：冻结的几条命令（`sheet.command.set-selection-frozen`，以及委托给它的冻结到行、到列、首行、首列；`sheet.command.set-frozen`、`sheet.command.cancel-frozen`）同样不在权限检查里，冻结的菜单项（功能区"视图"页的冻结、右键菜单的冻结）也没有 `disabled$`。复核时从"搜索功能"面板逐项执行冻结首行、冻结首列、取消冻结：`sheet.mutation.set-frozen` 照常执行（被防火墙取消），没有任何提示。SDK 的本意是不可编辑时不让改冻结：`_initFreezePermissionInterceptor()` 按 `WorkbookEditablePermission` 拦冻结线，只是没有被调用（UR-022）。冻结在 SDK 里因此没有任何生效的权限处理，所以和 UR-022 同源，提交时可以合并。

复核时一并提到的"重复上一步"（F4），复验订正为只读时没有可重复的动作、什么都不做，不在本报告内。

平台的规避：没有单独处理，靠只读守卫的防火墙取消这些 mutation（内容不变，代价是没有提示）。只读时工具栏与右键菜单关掉了，"搜索功能"面板不开放（UR-028），冻结线拖不动（UR-022 的规避），所以只读的界面上冻结已经没有入口，剩下的是这两个隐藏行列的快捷键；快捷键的回归在整行、整列选中时核对它们的 mutation 被取消、内容不变。

## 已有的上游讨论

- 没有检索：2026-10-02 起只用本地资源（本地参考源码与 1.0.1 发布包），不访问网络。【待补充：提交之前检索一次，建议的关键词：`set-rows-hidden permission`、`hide row protected sheet`、`SetRowHiddenCommand permission`、`freeze permission command`、`set-frozen readonly`】
- 相关：UR-022（冻结线的权限拦截没有注册）；UR-022 检索时记下的 [#3180](https://github.com/dream-num/univer/pull/3180)（2024-08，"some operations can be performed when have view permission"，已合并），是否覆盖过这两类命令要在提交前看一眼。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Hiding rows/columns and freezing are not permission-checked: in a non-editable workbook Ctrl/Cmd+9, Ctrl/Cmd+Shift+0 and the Freeze commands run without any alert

### Describe the bug

`SheetPermissionCheckController` checks the commands that *show* hidden rows and columns (`SetSpecificRowsVisibleCommand`, `SetSpecificColsVisibleCommand`, `SetSelectedRowsVisibleCommand`, `SetSelectedColsVisibleCommand`) against `WorkbookEditablePermission`, the worksheet row/column style permissions and range protection, and the context-menu items "Hide selected rows/columns" are disabled with the same permissions. The commands that *hide* rows and columns, `SetRowHiddenCommand` (`sheet.command.set-rows-hidden`) and `SetColHiddenCommand` (`sheet.command.set-col-hidden`), are not checked anywhere.

The freeze commands are not checked either: `SetFrozenCommand`, `CancelFrozenCommand` and sheets-ui's `SetSelectionFrozenCommand` (which "Freeze first row", "Freeze first column" and "Freeze to this row/column" delegate to). The Freeze menu items only have `hidden$`, no `disabled$`.

So in a workbook whose `WorkbookEditablePermission` is `false` (no protection rules; the authz service does not allow `Edit`):

1. With whole rows selected, Ctrl/Cmd+9 executes `sheet.command.set-rows-hidden` and `sheet.mutation.set-row-hidden`; with whole columns selected, Ctrl/Cmd+Shift+0 executes `sheet.command.set-col-hidden` and `sheet.mutation.set-col-hidden`. No permission alert is shown.
2. Running "Freeze first row", "Freeze first column" or "Cancel freeze" (we ran them from **Search features**, Ctrl/Cmd+Shift+P) executes `sheet.mutation.set-frozen`, again without any alert.

In our app a `BeforeCommandExecute` listener cancels mutations of read-only documents, so nothing changed and the shortcuts just seemed to do nothing. By reading the code, without such a listener the rows/columns are hidden and the freeze is changed (both also go onto the undo stack), although the user cannot edit the workbook, and the user cannot unhide the rows again, because unhiding is checked.

(With only cells selected, Ctrl/Cmd+9 and Ctrl/Cmd+Shift+0 do nothing in any workbook, because these commands only take whole-row/whole-column selections. That is unrelated to permissions.)

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接；下面是最小的配置】

1. Create a workbook with some data and make it non-editable without protection rules, e.g. override `IAuthzIoService` so that `allowed()` returns `false` for `UnitAction.Edit` (and `true` for `View`/`Copy`).
2. Click row header 20 to select the whole row and press Ctrl+9 (Cmd+9 on macOS): no alert; `sheet.command.set-rows-hidden` and `sheet.mutation.set-row-hidden` are executed, so row 20 is hidden. (We observed the executed mutation; in our app it was then cancelled by our own listener.)
3. Click column header K and press Ctrl+Shift+0 (Cmd+Shift+0 on macOS): the same with `sheet.mutation.set-col-hidden`.
4. Press Ctrl/Cmd+Shift+P, type `freeze` and run "Freeze first row": no alert; `sheet.mutation.set-frozen` is executed.

By reading the code (not tried, because our read-only mode hides the toolbar and the context menu): the context-menu items "Freeze → Freeze first row / Freeze first column / Cancel freeze" and the toolbar's View → Freeze menu are enabled and behave like step 4, while "Hide selected rows/columns" in the context menu is disabled. The Facade's `FWorksheet.hideRows()` / `hideColumns()` / `setFreeze()` / `setFrozenRows()` / `cancelFreeze()` also succeed, whereas `showRows()` / `unhideRow()` are rejected with the alert.

### Expected behavior

Hiding rows/columns and freezing go through the same permission check as showing rows/columns: in a non-editable workbook they are rejected with the usual alert and nothing changes. The Freeze menu items are disabled like "Hide selected rows/columns".

### Actual behavior

The commands run without any permission check, as described above. Observed in our end-to-end tests (whole-row and whole-column selections) in Chromium, Google Chrome and WebKit.

### Root cause analysis

Paths are relative to the repository root, at tag v1.0.0 (the same code is in the published 1.0.1 packages).

- `packages/sheets/src/controllers/permission/sheet-permission-check.controller.ts`, `_getPermissionCheck()`: there are cases for the four "show" commands, but none for `SetRowHiddenCommand`, `SetColHiddenCommand`, `SetFrozenCommand` or `CancelFrozenCommand`. `_getPermissionCheck()` in `packages/sheets-ui/src/controllers/permission/sheet-permission-check-ui.controller.ts` only adds text input, opening the cell editor and the format painter.
- `SetRowHiddenCommand` in `packages/sheets/src/commands/commands/set-row-visible.command.ts` and `SetColHiddenCommand` in `packages/sheets/src/commands/commands/set-col-visible.command.ts` take `params.ranges` or the whole-row/whole-column selections (`getSelectedRowRanges()` / `getSelectedColRanges()` keep only `RANGE_TYPE.ROW` / `RANGE_TYPE.COLUMN` ranges) and execute `SetRowHiddenMutation` / `SetColHiddenMutation` directly.
- `SetRowHiddenShortcutItem` and `SetColHiddenShortcutItem` in `packages/sheets-ui/src/controllers/shortcuts/operation.shortcut.ts` bind Ctrl/Cmd+9 and Ctrl/Cmd+Shift+0 to these commands with only `whenSheetEditorFocused` as precondition. The context-menu items `HideRowMenuItemFactory` / `HideColMenuItemFactory` (`packages/sheets-ui/src/menu/menu.ts`) are disabled by permission, but that covers neither the shortcuts nor the Facade: in `packages/sheets/src/facade/f-worksheet.ts`, `hideRow()`, `hideRows()`, `hideColumn()` and `hideColumns()` execute the unchecked commands, while `unhideRow()` and `showRows()` go through the checked `SetSpecificRowsVisibleCommand`.
- Freeze: `SetSelectionFrozenCommand` in `packages/sheets-ui/src/commands/commands/set-frozen.command.ts` executes `SetFrozenMutation` directly; `SetRowFrozenCommand`, `SetColumnFrozenCommand`, `SetFirstRowFrozenCommand` and `SetFirstColumnFrozenCommand` in the same file delegate to it. `SetFrozenCommand` and `CancelFrozenCommand` in `packages/sheets/src/commands/commands/set-frozen.command.ts` execute `SetFrozenMutation` directly as well; the Facade's `setFreeze()`, `cancelFreeze()`, `setFrozenRows()` and `setFrozenColumns()` (`f-worksheet.ts`) use them. The menu items in `packages/sheets-ui/src/menu/frozen.menu.ts` (the toolbar's `SheetFrozenToolbarMenuItemFactory`, and the context menu's `SheetFrozenMenuItemFactory` with its children up to `CancelFrozenMenuItemFactory`) only have `hidden$`.
- That freezing is meant to require `WorkbookEditablePermission` can be seen in `_initFreezePermissionInterceptor()` (`packages/sheets-ui/src/controllers/permission/sheet-permission-interceptor-canvas-render.controller.ts`), which is never called (reported separately: 【待补充：UR-022 提交之后的链接；也可以把两份合并成一个 issue】).

### Suggested fix

- Add `SetRowHiddenCommand` and `SetColHiddenCommand` to `SheetPermissionCheckController._getPermissionCheck()` with the same permission types as the hide menu items, passing `params?.ranges` (`permissionCheckWithRanges()` falls back to the current selection when it is `undefined`):

  ```ts
  case SetRowHiddenCommand.id:
      params = commandInfo.params as ISetRowHiddenCommandParams | undefined;
      permission = this.permissionCheckWithRanges({
          workbookTypes: [WorkbookEditablePermission],
          worksheetTypes: [WorksheetEditPermission, WorksheetSetRowStylePermission],
          rangeTypes: [RangeProtectionPermissionEditPoint],
      }, params?.ranges, params?.unitId, params?.subUnitId);
      errorMsg = this._localeService.t<LocaleKey>('sheets.permission.dialog.setRowColStyleErr');
      break;
  // SetColHiddenCommand: the same with WorksheetSetColumnStylePermission
  ```

- Check `SetFrozenCommand` and `CancelFrozenCommand` there as well (at least `WorkbookEditablePermission`, as `_initFreezePermissionInterceptor()` does), and `SetSelectionFrozenCommand` in `SheetPermissionCheckUIController`, since it does not go through `SetFrozenCommand`. Give the Freeze menu items a `disabled$` based on the same permission.

### Environment

- Univer: 1.0.1 (`@univerjs/*`), same code in 1.0.0. Affected packages: `@univerjs/sheets`, `@univerjs/sheets-ui`.
- Browsers: Chromium and WebKit bundled with Playwright 1.63.0, and Google Chrome 153, headless, driven by Playwright.
- OS: macOS 27.0 (Apple silicon).
