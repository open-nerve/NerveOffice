# UR-025 批注浮层不看权限：工作簿不可编辑时批注的文本框仍可输入、可调整大小，更新批注的命令也没有权限检查

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue（浮层的只读可以按功能请求提，命令缺少权限检查按缺陷报；也可以拆成两份）
> 出处：M2-P3 S3 的 E2E 发现（输入）、M2-P3 审查 A6（调整大小）；平台的规避 `apps/web/src/editor/read-only/note-popup.ts`（观察批注浮层出现，给文本框设 `readOnly` 与 `resize: none`）与只读守卫的防火墙，E2E `tests/e2e/specs/editor/read-only.spec.ts`"改批注""Facade：批注""还能读"｜发现版本：1.0.1｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/sheets-note-ui@1.0.1` `lib/es/index.js` 第 691–695 行（`Textarea` 没有只读的属性，传了 `onResize`）；1.0.0 源码 `packages/sheets-note-ui/src/views/Note.tsx`；E2E 在 Chromium、Chrome、WebKit 上复现：只读时经界面续写批注、经 Facade 的 `createOrUpdateNote`，`sheet.mutation.update-note` 都执行到了平台的防火墙才被取消，SDK 没有拦

## 摘要（中文）

sheets-note-ui 的批注浮层总是一个可以输入的文本框：没有只读的开关，也不看工作簿与工作表的权限，打开时还会被程序聚焦；右下角可以拖动调整大小（按源码，改尺寸也经同一条命令写回，Note.tsx L145-153；我们的运行里拖大之后没有看到这条命令，浮层保持拖大的样子）。改文字经 `SheetUpdateNoteCommand` 写回，而这条命令没有权限检查：平台的 E2E 里，工作簿不可编辑时它照常执行，产生的 `sheet.mutation.update-note` 是被平台自己的防火墙（`BeforeCommandExecute` 里取消修改文档的 mutation）取消的。没有这层防火墙的集成方，不可编辑的工作簿里批注会被改掉。

平台的规避：只读时在页面上观察批注浮层出现，给文本框设 `readOnly` 与 `resize: none`（找元素用的是 SDK 的 DOM 标记 `data-u-comp="note-textarea"`，不是公开 API）；防火墙兜底。希望上游：更新批注的命令按工作表的编辑权限检查；浮层在不能编辑时渲染成只读。

## 已有的上游讨论

- 没有找到对应的 issue（2026-09-29 检索，GitHub 搜索接口）：`note permission readonly`（0 条）。【待补充：提交前再按 `SheetUpdateNoteCommand permission` 检索一次】

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Sheet notes can be edited in a non-editable workbook: the note popup has no read-only mode and `SheetUpdateNoteCommand` has no permission check

### Describe the bug

The note popup of `@univerjs/sheets-note-ui` is always an editable `<textarea>`: it has no read-only mode and does not check the workbook/worksheet permissions. When the popup is opened by a trigger it is even focused programmatically, and the textarea can be resized with its corner handle. Text changes are written back through `SheetUpdateNoteCommand` (by the code, size changes are too, `Note.tsx` L145-153; in our runs resizing did not issue the command, the popup just stayed enlarged), and that command is not subject to a permission check.

In a workbook that is not editable (for example `WorkbookEditablePermission` is `false`, no protection rules), hovering a cell with a note shows the popup; the user can type into it and resize it, and the typed text is written back: `sheet.mutation.update-note` is executed. The same happens through the Facade (`FRange.createOrUpdateNote()`). In our app a `BeforeCommandExecute` listener cancels document mutations for read-only users, which is how we noticed that the mutation was reaching the command service at all.

We would like:
1. `SheetUpdateNoteCommand` (and the other note commands) to be checked against the worksheet edit permission, like cell edits are;
2. the popup to be rendered read-only (no typing, no resize handle; text still selectable and copyable) when the user cannot edit the sheet, or a configuration option to force that.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接】

1. Create a workbook with a note on a cell and make the workbook non-editable, e.g. override `IAuthzIoService` so that `allowed()` returns `false` for `UnitAction.Edit` (and `true` for `View`/`Copy`).
2. Hover the cell: the note popup appears. Click into it, type, then click another cell: `sheet.mutation.update-note` is executed and the note text is changed. The lower-right corner of the popup can be dragged to enlarge it.
3. Alternatively: `univerAPI.getActiveWorkbook().getActiveSheet().getRange('A1').createOrUpdateNote({ note: 'x', width: 160, height: 60 })` succeeds.

### Expected behavior

In a non-editable sheet the note cannot be changed: the command is rejected by the permission check (with the usual "no permission" dialog), and the popup shows the note read-only.

### Actual behavior

The note text and size can be changed.

### Where in the code

Line numbers refer to tag v1.0.0 (the same code is in 1.0.1).

- `packages/sheets-note-ui/src/views/Note.tsx` L98-107 (focus on open), L110-153 (`updateNote` on text change and on resize), L156-172 (`Textarea` without a read-only prop, with `onResize`).
- 【待补充：`SheetUpdateNoteCommand` 所在的 `packages/sheets-note/src/commands/` 与 sheets 的权限检查（`SheetPermissionCheckController`）里没有它的条目，提交前核对具体行号】

### Environment

- Univer: 1.0.1 (`@univerjs/*`), same code in 1.0.0. Affected packages: `@univerjs/sheets-note`, `@univerjs/sheets-note-ui`.
- Browsers: Chromium and WebKit bundled with Playwright 1.63.0, and Google Chrome 153, headless, driven by Playwright.
- OS: macOS 27.0 (Apple silicon).
