# UR-023 工作簿不可编辑、又没有保护规则时，编辑栏的编辑器能被聚焦，编辑器的上下文不复位（按下与松开两条路径）

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M2-P3 S3 的 E2E 发现（按下的路径）、M2-P3 审查 A1（松开的路径，三个浏览器复现）；平台的规避 `apps/web/src/editor/read-only/formula-bar.ts`，E2E `tests/e2e/specs/editor/read-only.spec.ts`"编辑栏点不进去"｜发现版本：1.0.1｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/sheets-ui@1.0.1` `lib/es/index.js` 第 22123–22145 行（编辑栏按下：工作簿不可编辑时只置 `FOCUSING_FX_BAR_EDITOR` 并聚焦编辑栏的编辑器）、第 11846–11848 行（复位这些上下文的 `_exitInput` 只在单元格编辑器关闭时执行）；`@univerjs/sheets-formula-ui@1.0.1` `lib/es/index.js` 第 6864–6874 行（编辑框自己的 `onMouseUp` 聚焦）、第 1860–1884 行、第 2872–2889 行；`@univerjs/docs-ui@1.0.1` `lib/es/index.js` 第 4514–4534 行；1.0.0 源码相同

## 摘要（中文）

工作簿不可编辑（`WorkbookEditablePermission` 为假）、又没有保护规则时，点编辑栏不会打开单元格编辑器，但编辑栏的内部编辑器仍然被聚焦：`EDITOR_ACTIVATED` 置为真，按下的路径还置 `FOCUSING_FX_BAR_EDITOR`。复位这两个上下文的代码只在单元格编辑器关闭时执行，而单元格编辑器根本没有打开，于是上下文一直是真：之后查找（Ctrl/Cmd+F）与方向键这些要求"编辑器没有激活"的快捷键失效（点回单元格也不恢复），格式的快捷键转给了编辑栏里的文字编辑器，键入的字进了编辑栏的内部文档。

聚焦有两条路径：
1. 在编辑框上按下：`FormulaBar` 的 `handlePointerDown` 在 `editorActivationDisable` 时只做 `setContextValue(FOCUSING_FX_BAR_EDITOR, true)` 与 `editorService.focus(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)`；
2. 在别处按下（例如名称框）、在编辑框上松开：sheets-formula-ui 的编辑框自己的 `onMouseUp` 调用 `focusFormulaEditor`（`editorService.focus` 与 DOM 焦点），组件的内部状态置为聚焦，`useRefactorEffect` 在渲染之后再置一次 `EDITOR_ACTIVATED`。

平台的规避：只读时在页面上（捕获阶段）拦下落在编辑框上的按下；另外订阅编辑器服务的 `focus$`，焦点落到编辑栏的编辑器时在微任务里 `blur(true)`，并把 `FOCUSING_FX_BAR_EDITOR` 复位。能编辑时同样存在第 2 条路径（不经 `handlePointerDown`，单元格编辑器没有打开，编辑栏却聚焦了），只是能编辑时用户接着键入，影响小。

## 已有的上游讨论

- 没有找到对应的 issue（2026-09-29 检索，GitHub 搜索接口）：`formula bar EDITOR_ACTIVATED`、`"formula bar" permission focus`、`formula bar readonly shortcut`。
- 相关但不同：[#7629](https://github.com/dream-num/univer/pull/7629)（2026-09-09 合并进 `dev`，加固嵌入编辑器的焦点与快捷键归属），[#7756](https://github.com/dream-num/univer/pull/7756)（2026-09-27）；从描述看不涉及工作簿不可编辑时的编辑栏。【待补充：提交前在 `dev` 上重跑一次，确认仍然存在】

---

## Issue（英文，可以直接提交）

**Title:** [Bug] In a non-editable workbook without protection rules, the formula bar editor can still be focused and `EDITOR_ACTIVATED` / `FOCUSING_FX_BAR_EDITOR` are never reset (pointer-down and mouse-up paths)

### Describe the bug

When the workbook is not editable (`WorkbookEditablePermission` is `false`) and there are no protection rules, clicking the formula bar does not open the cell editor, which is correct. But the formula bar's internal editor is still focused, and the context values that mark an active editor are set and never reset, because the only code that resets them runs when the cell editor closes, and the cell editor was never opened:

- shortcuts that require "no editor activated", such as Find (Ctrl/Cmd+F) and the arrow keys, stop working, even after clicking back into a cell;
- formatting shortcuts (Ctrl/Cmd+B …) are routed to the text editor of the formula bar;
- typed characters go into the formula bar's internal document.

There are two ways to get there:

1. **Pointer down on the formula editor.** `FormulaBar`'s `handlePointerDown` sets `FOCUSING_FX_BAR_EDITOR` to `true` and, because `editorActivationDisable` is `true`, calls `editorService.focus(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)` (which sets `EDITOR_ACTIVATED`).
2. **Pointer down elsewhere (e.g. on the name box), pointer up on the formula editor.** The formula editor's own `onMouseUp` handler calls `setIsFocus(true)` and `focusFormulaEditor()`, i.e. `editorService.focus()` plus DOM focus; after the re-render `useRefactorEffect` sets `EDITOR_ACTIVATED` to `true` again. This path does not go through `handlePointerDown` at all, so it also exists in an editable workbook (the formula bar gets focused without the cell editor being opened).

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接】

1. Create a workbook and make it non-editable without protection rules, e.g. override `IAuthzIoService` so that `allowed()` returns `false` for `UnitAction.Edit` (and `true` for `View`/`Copy`).
2. Path 1: select a cell and click the formula bar's input area. Path 2: press the mouse on the name box, move to the formula bar's input area and release there.
3. Click any cell, then press Ctrl/Cmd+F: the find dialog does not open. Press an arrow key: the selection does not move. Press Ctrl/Cmd+B: `sheet.command.set-range-bold` is executed and, because an editor is active, applies `doc.command.set-inline-format-bold` to the formula bar's document instead of reaching the permission check.

### Expected behavior

In a non-editable workbook the formula bar editor is not focused (or, if it is, it is released and the context values are reset), and Find / arrow keys keep working.

### Actual behavior

`EDITOR_ACTIVATED` (and on path 1 `FOCUSING_FX_BAR_EDITOR`) stay `true` for the rest of the session; Find and the arrow keys do nothing. We reproduced path 2 in Chromium, Chrome and WebKit.

### Root cause analysis

Paths are relative to the repository root; line numbers refer to tag v1.0.0 (the same code is in 1.0.1).

- `packages/sheets-ui/src/views/formula-bar/FormulaBar.tsx` L248-281: with `editorActivationDisable` the pointer-down handler only sets `FOCUSING_FX_BAR_EDITOR` and focuses the formula bar editor.
- `packages/sheets-ui/src/controllers/editor/editing.render-controller.ts` L871-874: `_exitInput()` resets `EDITOR_ACTIVATED` and `FOCUSING_FX_BAR_EDITOR`, but it only runs when the cell editor is closed.
- `packages/sheets-formula-ui/src/views/formula-editor/index.tsx` L535-549 (`handleMouseUp`, bound at L568) and `hooks/use-focus.ts` L32, L53: focusing on mouse up regardless of permissions; `hooks/use-refactor-effect.ts` L37 sets `EDITOR_ACTIVATED` while the internal focus state is `true`.
- `packages/docs-ui/src/services/editor/editor-manager.service.ts` `focus()` sets `EDITOR_ACTIVATED`; `blur()` resets it together with `FOCUSING_EDITOR_STANDALONE` and `FOCUSING_COMMENT_EDITOR`.

### Suggested fix

When the workbook is not editable, do not focus the formula bar editor at all (skip `editorService.focus` in `handlePointerDown` and skip the refocus in `handleMouseUp`), or blur it and reset `FOCUSING_FX_BAR_EDITOR` right away, the same way `_exitInput()` does when the cell editor closes.

### Environment

- Univer: 1.0.1 (`@univerjs/*`), same code in 1.0.0. Affected packages: `@univerjs/sheets-ui`, `@univerjs/sheets-formula-ui`.
- Browsers: Chromium and WebKit bundled with Playwright 1.63.0, and Google Chrome 153, headless, driven by Playwright.
- OS: macOS 27.0 (Apple silicon).
