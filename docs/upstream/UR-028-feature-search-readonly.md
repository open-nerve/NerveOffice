# UR-028 工作簿不可编辑时"搜索功能"照样打开、列出编辑功能：不看 `toolbar`/`contextMenu: false`，也没有办法关掉

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue（与 UR-019 是同一个组件、不同的根因；单独提，提交时互相引用）
> 出处：M2-P6 第 4 片复核 F1（`docs/v0.1/M2-组织空间与权限/reviews/P6-S4-编辑器只读.md`）；平台的规避 `apps/web/src/editor/read-only/read-only-guard.ts` 的 `READ_ONLY_GUARDED_COMMANDS`（只读时在执行前取消 `ui.operation.open-feature-search`），只读时关掉工具栏与右键菜单的配置在 `apps/web/src/editor/profile/sheet-profile.ts`（`toolbar: false, contextMenu: false`），E2E `tests/e2e/specs/editor/read-only.spec.ts`"'搜索功能'面板"（能编辑时作对照：在面板里执行"粗体"确实改动）与 `tests/e2e/specs/editor/read-only-shortcuts.spec.ts`（只读时没有白名单之外的面板与对话框）｜发现版本：1.0.1｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/ui@1.0.1` `lib/es/index.js` 的 `FeatureSearchShortcut` 与 `FeatureSearchController`（快捷键没有前提条件，控制器无条件登记）、`UniverUIPlugin`（总是注册这个控制器，并在就绪时取用它）、`OpenFeatureSearchOperation`（打开面板的操作，不做任何检查）、`FeatureSearch` 组件（候选项取自功能区与全部右键菜单的登记，只按菜单项自己与祖先的 `hidden$`、`disabled$` 过滤）、`DesktopWorkbenchContent`（`toolbar`、`contextMenu` 只决定工作台渲染不渲染工具栏与右键菜单）、`FormatPainterMenuItemFactory` 与 `ClearFormattingMenuItemFactory`（只按"有没有可用的格式刷适配器"停用）、`FormatPainterSessionService` 的 `canStart`、`canClear`；导出清单里没有 `FeatureSearchController` 与 `OpenFeatureSearchOperation`；`@univerjs/sheets-ui@1.0.1` `lib/es/index.js` 里 `FormatPainterController` 登记的表格格式刷适配器（`id: "sheet-cells"`，`canStart` 只看有没有选区）、`SheetFrozenMenuItemFactory`、`FrozenFirstRowMenuItemFactory`、`FrozenFirstColMenuItemFactory`、`CancelFrozenMenuItemFactory`（右键菜单的冻结、冻结首行、冻结首列、取消冻结都没有 `disabled$`）、`CutMenuItemFactory` 与 `PasteMenuItemFactory`（对照：`disabled$` 含 `WorkbookEditablePermission`）；`@univerjs/docs-ui@1.0.1` `lib/es/index.js` 的 `DeleteCurrentParagraphMenuItemFactory`、`TableBlockPasteMenuItemFactory`（文字文档段落菜单的"删除""粘贴"既没有 `hidden$` 也没有 `disabled$`）、`CutCurrentParagraphMenuItemFactory`（段落菜单的"剪切"只按复制权限停用）、`DocUIController._initMenus`（docs-ui 不论有没有文字文档都登记菜单）；1.0.0 源码相同（本地参考 `refer/univer` 是 v1.0.0；1.0.2 与 `dev` 没有核对）

## 摘要（中文）

工作簿不可编辑（`WorkbookEditablePermission` 为假，没有保护规则，平台的查看者就是这样）时，按 Ctrl/Cmd+Shift+P 照样打开"搜索功能"面板，里面列着格式刷、清除格式、冻结首行、冻结首列、取消冻结、剪切、删除、粘贴等编辑功能。平台只读时用 `toolbar: false`、`contextMenu: false` 关掉了工具栏与右键菜单，但面板的候选项直接取自菜单的登记（功能区与全部右键菜单），不看这两个配置；面板本身也关不掉：打开它的操作与快捷键没有任何前提条件，控制器总是注册，而且没有导出（插件配置的 `override` 要用它的标识，也就拿不掉它），菜单配置只能隐藏功能区上的按钮，快捷键照样能打开。

面板按菜单项与祖先的 `hidden$`、`disabled$` 过滤，所以按权限停用的菜单项不会列出（按源码，表格的剪切、粘贴、清除内容、删除行列等都是这样）。列出来的是没有按权限停用的：
- `@univerjs/ui` 的格式刷与清除格式：只要有选区就可用（表格的格式刷适配器 `canStart` 只看有没有选区）。从面板执行格式刷，进入格式刷状态，点单元格时才被权限检查拦下、弹提示；清除格式执行时被权限检查拦下；
- sheets-ui 右键菜单的冻结首行、冻结首列、取消冻结：菜单项没有 `disabled$`，冻结的命令也没有权限检查（UR-027）。执行时没有任何提示，`sheet.mutation.set-frozen` 照常执行（被平台的防火墙取消），看起来就是"点了没反应"；
- 剪切、删除、粘贴：按源码推测是 docs-ui 登记的文字文档段落菜单项（表格要用 docs-ui 做单元格编辑器，它的菜单不论有没有文字文档都登记），例如 `DeleteCurrentParagraphMenuItemFactory`、`TableBlockPasteMenuItemFactory` 既没有 `hidden$` 也没有 `disabled$`，在表格里同样会被列出。【待补充：复核时没有记下这三项的命令 id，提交前在 SDK 默认配置下核对是哪几个菜单项】

文档内容始终不变（权限检查与平台的防火墙兜底）。与 UR-019 的关系：同一个组件，UR-019 是"隐藏了带子菜单的父项，子项仍能搜到"（祖先只按嵌套结构收集），这里是"不可编辑时没有按权限停用的编辑功能、关掉的工具栏与右键菜单里的功能仍能搜到，而且面板关不掉"，根因与修法都不同，所以单独一份，没有写成 UR-019 的补充。

平台的规避：只读时在执行前取消 `ui.operation.open-feature-search`（`READ_ONLY_GUARDED_COMMANDS`），代价是只读时没有"搜索功能"面板（里面列的都是编辑功能，查看者用不上）。E2E 核对只读时按快捷键不出面板、内容不变，能编辑时作对照；快捷键的回归核对只读时没有弹出白名单之外的面板与对话框。

## 已有的上游讨论

- 没有检索：2026-10-02 起只用本地资源（本地参考源码与 1.0.1 发布包），不访问网络。【待补充：提交之前检索一次，建议的关键词：`feature search permission`、`feature search readonly`、`open-feature-search`、`FeatureSearch disable`、`contextMenu false feature search`】
- 相关：UR-019（同一个组件：隐藏父菜单之后子项仍能被功能搜索找到；2026-09-28 检索时没有找到对应的 issue）；UR-027（冻结的命令没有权限检查）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Search features (Ctrl/Cmd+Shift+P) opens in a non-editable workbook and offers editing features; it ignores `toolbar: false` / `contextMenu: false` and cannot be turned off

### Describe the bug

In a workbook whose `WorkbookEditablePermission` is `false` (no protection rules; the authz service does not allow `Edit`), with the toolbar and the context menu turned off through the UI plugin config (`toolbar: false`, `contextMenu: false`), Ctrl/Cmd+Shift+P still opens **Search features**, and it lists editing features, among them Format Painter, Clear formatting, Freeze first row, Freeze first column, Cancel freeze, Cut, Delete and Paste.

Running them from the panel:

- Freeze first row / Freeze first column / Cancel freeze execute `sheet.mutation.set-frozen` without any permission alert, because the freeze commands have no permission check (reported separately: 【待补充：UR-027 提交之后的链接】). In our app a `BeforeCommandExecute` listener cancelled the mutation, so nothing seemed to happen.
- Format Painter enters format-painter mode; the permission alert only appears when a cell is clicked.
- Clear formatting runs `ClearSelectionFormatCommand`, which the permission check rejects (alert).

Three things combine:

1. **Feature Search cannot be turned off.** `FeatureSearchController` is always registered, neither `ui.operation.open-feature-search` nor its shortcut has a precondition, and neither the controller nor the operation is exported, so the plugin's `override` option cannot drop it either. The `menu` config can hide the ribbon button (`ui.operation.open-feature-search`), but the shortcut still opens the panel.
2. **It ignores `toolbar: false` and `contextMenu: false`.** The candidates are collected from the ribbon schema and from every context-menu position (`MenuManagerPosition.CONTEXT_MENU`), while these two options only stop the workbench from rendering the toolbar and the context menu. `contextMenu` is documented as "If Univer should make the context menu usable", yet its items stay usable through Feature Search.
3. **Some editing items have no permission-aware `disabled$`.** Feature Search does skip items whose own or ancestor `hidden$` / `disabled$` is `true`, so, by reading the code, most sheet items (Cut, Paste, Clear contents, Delete rows, …) are left out through their `WorkbookEditablePermission`-based `disabled$`. The items listed above have none:
   - Format Painter and Clear formatting (`@univerjs/ui`) are only disabled when the active format-painter adapter cannot start, and the sheet adapter's `canStart` only checks that there is a selection;
   - the sheet context-menu Freeze items only have `hidden$`;
   - Cut / Delete / Paste are, by reading the code, probably the Docs paragraph context-menu items: `@univerjs/docs-ui` registers its menus even when there is no document (sheets need docs-ui for the cell editor), and e.g. `DeleteCurrentParagraphMenuItemFactory()` and `TableBlockPasteMenuItemFactory()` have neither `hidden$` nor `disabled$`, so they are offered in a spreadsheet as well. 【待补充：复核时没有记下这三项的命令 id；提交前在 SDK 默认配置下核对，确认之后保留这一条，否则删掉】

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接；下面是最小的配置】

1. Create a workbook with the sheets core preset (1.0.1) and make it non-editable without protection rules, e.g. override `IAuthzIoService` so that `allowed()` returns `false` for `UnitAction.Edit` (and `true` for `View`/`Copy`). Optionally pass `toolbar: false, contextMenu: false` to the UI plugin; it makes no difference.
2. Click a cell and press Ctrl+Shift+P (Cmd+Shift+P on macOS): **Search features** opens.
3. Type `freeze`: "Freeze first row", "Freeze first column" and "Cancel freeze" are listed. Run "Freeze first row": no alert; `sheet.mutation.set-frozen` is executed and the first row is frozen. (We observed the executed mutation; in our app it was then cancelled by our own listener.)
4. Type `format`: "Format Painter" and "Clear formatting" are listed. Run "Format Painter": format-painter mode starts; clicking a cell shows the permission alert. Run "Clear formatting": `ClearSelectionFormatCommand` is rejected with the permission alert.

Screenshots: 【待补充：SDK 默认配置下，不可编辑的工作簿里"搜索功能"列出上述各项的截图】

### Expected behavior

- In a non-editable workbook, Feature Search only offers what the user can actually do: editing items are disabled there, as they would be in the toolbar or the context menu.
- Feature Search honors `toolbar: false` / `contextMenu: false` (it does not offer items from surfaces the integrator turned off), or there is an option to turn Feature Search off, shortcut included.

### Actual behavior

See above. The behavior does not depend on the browser (menu logic); we observed it in our app in a headless browser driven by Playwright.

### Root cause analysis

Paths are relative to the repository root, at tag v1.0.0 (the same code is in the published 1.0.1 packages).

- `packages/ui/src/controllers/feature-search/feature-search.controller.ts`: the shortcut (`FeatureSearchShortcut`, `CTRL_COMMAND | SHIFT | P`) has no `preconditions`; `FeatureSearchController` registers the operation and the shortcut unconditionally. `packages/ui/src/plugin.ts`: `UniverUIPlugin` always registers the controller and touches it on ready. `packages/ui/src/commands/operations/open-feature-search.operation.ts`: `OpenFeatureSearchOperation` opens the dialog without any check. `packages/ui/src/index.ts` exports neither `FeatureSearchController` nor `OpenFeatureSearchOperation`, so `override` (`mergeOverrideWithDependencies()` in `packages/core/src/services/plugin/plugin-override.ts`, which can drop a dependency by its identifier) cannot be used. The only related config is the ribbon button (`packages/ui/src/menu/schema.ts`).
- `packages/ui/src/views/components/feature-search/FeatureSearch.tsx`: the candidates come from `ribbonService.ribbon$` and `menuManagerService.getMenuByPositionKey(MenuManagerPosition.CONTEXT_MENU)` (all context-menu positions, including the Docs paragraph menu, see the default menu tree in `packages/ui/src/services/menu/menu-manager.service.ts`), independent of the workbench options. `observeCandidate()` skips an item only if it or an ancestor is hidden or disabled.
- `DesktopWorkbenchContent` in `packages/ui/src/views/workbench/Workbench.tsx`: `toolbar` and `contextMenu` only decide whether the header bar and `DesktopContextMenu` are rendered; both options are documented on `IWorkbenchOptions` in `packages/ui/src/controllers/ui/ui.controller.ts`.
- `packages/ui/src/menu/format-painter.menu.ts`: Format Painter and Clear formatting are disabled only through `FormatPainterSessionService.canStart()` / `canClear()` (`packages/ui/src/services/format-painter/format-painter-session.service.ts`); the sheet adapter registered by `FormatPainterController` in `packages/sheets-ui/src/controllers/format-painter/format-painter.controller.ts` sets `canStart: () => !!this._selectionManagerService.getCurrentLastSelection()`.
- `packages/sheets-ui/src/menu/frozen.menu.ts`: `SheetFrozenMenuItemFactory` (the "Freeze" submenu of the context menu) and `FrozenFirstRowMenuItemFactory`, `FrozenFirstColMenuItemFactory` and `CancelFrozenMenuItemFactory` only have `hidden$`, no `disabled$`. Compare `CutMenuItemFactory` / `PasteMenuItemFactory` in `packages/sheets-ui/src/menu/menu.ts`, whose `disabled$` includes `WorkbookEditablePermission`; by reading the code they are not listed.
- Probably (see above): in `packages/docs-ui/src/menu/paragraph-menu.ts`, `DeleteCurrentParagraphMenuItemFactory`, `TableBlockPasteMenuItemFactory` and `TableBlockDeleteMenuItemFactory` have neither `hidden$` nor `disabled$`, and `CutCurrentParagraphMenuItemFactory` is only disabled without copy permission on the current document; `DocUIController._initMenus()` in `packages/docs-ui/src/controllers/ui.controller.ts` merges the docs-ui menu schema unconditionally.

A related report about the same component: Feature Search still lists the children of a SUBITEMS menu hidden via the `menu` config 【待补充：UR-019 提交之后的链接】.

### Suggested fix

- Let Feature Search honor the workbench options: skip ribbon candidates when `toolbar` is `false` and context-menu candidates when `contextMenu` is `false`; and/or add an option to disable Feature Search (do not register `OpenFeatureSearchOperation` and its shortcut).
- Give the editing items a permission-aware `disabled$`: let the sheet format-painter adapter's `canStart` also check `WorkbookEditablePermission` and the worksheet/range edit permissions (as the sheets-ui `FormatPainterMenuItemFactory` in `packages/sheets-ui/src/menu/menu.ts`, still used by the mobile schema, does with `getCurrentRangeDisable$`), give the Freeze items the same kind of `disabled$` as "Hide selected rows/columns", and, if confirmed, give the docs-ui paragraph items `hidden$: getMenuHiddenObservable(accessor, UniverInstanceType.UNIVER_DOC)`.

### Environment

- Univer: 1.0.1 (`@univerjs/*`), same code in 1.0.0. Affected packages: `@univerjs/ui`, `@univerjs/sheets-ui` (and probably `@univerjs/docs-ui`).
- Browsers: browser-independent (menu logic); observed in a headless browser from our test matrix (Chromium and WebKit bundled with Playwright 1.63.0, Google Chrome 153), driven by Playwright.
- OS: macOS 27.0 (Apple silicon).
