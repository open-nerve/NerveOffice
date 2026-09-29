# UR-024 表格图片的权限控制器设的是 `ISheetDrawingService` 的可编辑标志，渲染读的是 `IDrawingManagerService` 的，不可编辑时浮动图片照样能选中、拖动

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M2-P3 S3 的 E2E 发现（修复时的实测）；平台的规避 `apps/web/src/editor/read-only/read-only-guard.ts`（`applyWorksheetPoints` 里 `IDrawingManagerService.setDrawingEditable(false)`，内部 API 登记 `apps/web/src/editor/internal-api/registry.ts`），E2E `tests/e2e/specs/editor/read-only.spec.ts`"拖动浮动图片""删除浮动图片"｜发现版本：1.0.1｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/sheets-drawing-ui@1.0.1` `lib/es/index.js` 第 5058–5074、5157、5185 行（只设 `ISheetDrawingService` 的标志）；`@univerjs/drawing-ui@1.0.1` `lib/es/index.js` 第 857、915 行（画图片时读 `IDrawingManagerService.getDrawingEditable()` 决定挂不挂变换框）；`@univerjs/drawing@1.0.1` `lib/es/index.js` 第 1028–1036 行；E2E 在 Chromium、Chrome、WebKit 上复现；1.0.0 源码相同

## 摘要（中文）

工作簿或工作表不可编辑时，sheets-drawing-ui 的 `SheetDrawingPermissionController` 按"编辑"权限点把 `ISheetDrawingService` 的可编辑标志设为假，并摘掉当时已经画出的图片的变换框。但 drawing-ui 画图片时读的是另一个服务 `IDrawingManagerService` 的同名标志（初值为真，没有别处改它）来决定挂不挂变换框。切到有图片的工作表时，图片是之后才画的，照样挂上变换框：浮动图片能选中、能拖动；拖动的命令被权限检查拦下之后，图片停在拖到的位置（模型没变，切换工作表后复原）。

修复时的实测：只设 `ISheetDrawingService` 的标志，三个浏览器上图片照样能选中、拖动；设 `IDrawingManagerService` 的标志之后点不中、拖不动，能编辑时不受影响。平台的规避就是只读时设后者。

## 已有的上游讨论

- 没有找到对应的 issue（2026-09-29 检索，GitHub 搜索接口）：`setDrawingEditable`（0 条）、`image permission drag protected`（0 条）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] `SheetDrawingPermissionController` sets the editable flag on `ISheetDrawingService`, but the renderer reads `IDrawingManagerService`, so floating images stay selectable and draggable in a non-editable sheet

### Describe the bug

When the workbook or worksheet is not editable, `SheetDrawingPermissionController` (`@univerjs/sheets-drawing-ui`) calls `ISheetDrawingService.setDrawingEditable(false)` and removes the transformer from the images that are already drawn. The drawing renderer in `@univerjs/drawing-ui`, however, decides whether to attach a transformer to a newly drawn image by `IDrawingManagerService.getDrawingEditable()`, a different service instance whose flag starts as `true` and is never changed by the permission controller.

So when the user switches to a sheet with floating images (they are drawn after the permission controller ran), the images get a transformer: they can be selected and dragged. The resulting `sheet.command.set-sheet-image` is then rejected by the permission check, but the image stays drawn at the dropped position until the sheet is re-rendered.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接】

1. Create a workbook with two sheets; put a floating image on the second sheet.
2. Make the workbook non-editable, e.g. override `IAuthzIoService` so that `allowed()` returns `false` for `UnitAction.Edit` (we have not tried the worksheet-protection path).
3. Open the workbook on the first sheet, then switch to the second sheet and click the image: it gets selected (transformer handles). Drag it: it moves; on release a "no permission" dialog appears and the image stays at the new position until you switch sheets.

### Expected behavior

In a non-editable sheet, floating images cannot be selected or dragged (no transformer is attached).

### Actual behavior

Images drawn after the permission controller ran get a transformer and can be dragged.

### Root cause analysis

Paths are relative to the repository root; line numbers refer to tag v1.0.0 (the same code is in 1.0.1).

- `packages/sheets-drawing-ui/src/controllers/sheet-drawing-permission.controller.ts` L150-209 and L366, L419: only `this._sheetDrawingService.setDrawingEditable(...)` is called; `_handleDrawingEditableFalse()` removes the transformer only from objects that exist at that moment.
- `packages/drawing-ui/src/services/drawing-render.service.ts` L194 and L277: `this._drawingManagerService.getDrawingEditable()` decides whether `scene.attachTransformerTo()` is called.
- `packages/drawing/src/services/drawing-manager-impl.service.ts` L264, L1141-1151: `_editable` starts as `true`; `ISheetDrawingService` and `IDrawingManagerService` are separate instances, so setting one does not affect the other.

### Suggested fix

Have the permission controller set the flag on `IDrawingManagerService` too (or have the renderer consult `ISheetDrawingService` for sheet drawings).

### Environment

- Univer: 1.0.1 (`@univerjs/*`), same code in 1.0.0. Affected packages: `@univerjs/sheets-drawing-ui`, `@univerjs/drawing-ui`.
- Browsers: Chromium and WebKit bundled with Playwright 1.63.0, and Google Chrome 153, headless, driven by Playwright.
- OS: macOS 27.0 (Apple silicon).
