# UR-022 冻结线的权限拦截没有注册：工作簿不可编辑时冻结线照样拖得动；冻结区域的行列分隔线与非冻结区域不一致

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M2-P3 审查 B2、B7（`docs/v0.1/M2-组织空间与权限/reviews/`）；平台的规避 `apps/web/src/editor/read-only/freeze-handles.ts`，E2E `tests/e2e/specs/editor/read-only.spec.ts`"拖动冻结线""拖动冻结区域的行高"｜发现版本：1.0.1｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/sheets-ui@1.0.1` `lib/es/index.js` 第 14182 行（`FREEZE_PERMISSION_CHECK`）、第 14306、14325、14399、14415 行（冻结线移上、按下与拖动时问这个拦截点）、第 31959–32077 行（`SheetPermissionInterceptorCanvasRenderController` 的构造函数只调用了另外四个 `_init…`，第 32070–32077 行的 `_initFreezePermissionInterceptor` 没有被调用）；E2E 在 Chromium、Chrome、WebKit 上复现；1.0.0 源码相同；GitHub 上 `dev` 分支（2026-09-29）也没有调用

## 摘要（中文）

sheets-ui 的冻结线控制器（`HeaderFreezeRenderController`）在鼠标移上、按下与拖动时都先问自己的拦截点 `FREEZE_PERMISSION_CHECK`；按权限拦它的代码写在 `SheetPermissionInterceptorCanvasRenderController._initFreezePermissionInterceptor()` 里（工作簿可编辑才允许），但构造函数没有调用它。于是工作簿不可编辑时（没有保护规则、授权服务不允许编辑，平台的查看者就是这样），冻结线照样显示可以拖动的 `grab` 光标、拖得动；松开时执行 `sheet.command.set-frozen`——平台的只读防火墙取消了它的 mutation，模型不变，但界面上的冻结线停在拖到的位置（切换工作表之后复原）。没有防火墙的集成方，冻结会被改掉。

同一份只读的工作簿里，行列标题的分隔线（调整行高、列宽）在非冻结区域不显示调整的控制点（`HEADER_RESIZE_PERMISSION_CHECK` 生效），在冻结区域（例如冻结的第 1 行的下边）却仍显示 `row-resize` 光标、拖得动，松开时的 `sheet.command.delta-row-height` 再被权限检查拦下、弹出提示。数据不变，但两处表现不一致。

平台的规避：只读时在这份文档的冻结线控制器上注册总是不允许的拦截器（与 SDK 本来要注册的那个同一个拦截点）；冻结区域的分隔线不另外处理，E2E 核对数据不变。

## 已有的上游讨论

- 没有找到对应的 issue 或 PR（2026-09-29 检索，GitHub 搜索接口）：`FREEZE_PERMISSION_CHECK`（0 条）、`freeze permission`、`freeze readonly drag`、`_initFreezePermissionInterceptor`。
- 相关但不同：[#3180](https://github.com/dream-num/univer/pull/3180)（2024-08，"some operations can be performed when have view permission"，已合并，修的是只有查看权限时仍能执行的一些操作）；[#597](https://github.com/dream-num/univer/issues/597)（2023，冻结线能拖出视口，已关闭）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] The freeze-line permission interceptor is never registered, so the freeze line can be dragged in a non-editable workbook; resize handles in the frozen area also ignore the permission check on hover

### Describe the bug

`HeaderFreezeRenderController` asks its `FREEZE_PERMISSION_CHECK` interceptor on pointer enter, pointer down and pointer move before it shows the `grab` cursor and starts dragging a freeze line. The interceptor that should deny this when the workbook is not editable, `SheetPermissionInterceptorCanvasRenderController._initFreezePermissionInterceptor()`, exists but is never called: the constructor only calls the header-move, header-resize, range-fill and range-move initializers.

As a result, in a workbook whose `WorkbookEditablePermission` is `false` (no protection rules; the authz service simply does not allow `Edit`):

1. Hovering a freeze line shows the `grab` cursor, and the line can be dragged.
2. On pointer up `sheet.command.set-frozen` is executed. In our app a `BeforeCommandExecute` listener cancels the resulting `sheet.mutation.set-frozen`, so the model is unchanged, but the freeze line stays drawn where it was dropped until the sheet is re-rendered (e.g. after switching sheets). Without such a listener the freeze is changed even though the user cannot edit.

A related inconsistency in the same read-only workbook: the row/column resize handle does not appear on the headers of the normal (scrolling) area, because `HEADER_RESIZE_PERMISSION_CHECK` denies it on hover. On the headers of the frozen area, however (e.g. the lower edge of a frozen first row in the row header), the `row-resize` cursor still appears and the edge can be dragged; on pointer up `sheet.command.delta-row-height` is blocked by `SheetPermissionCheckController`, which shows the "no permission" dialog. The data is unchanged, but the two areas behave differently.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的 StackBlitz 链接；下面是最小的配置】

1. Create a workbook with a frozen first row and column (`freeze: { startRow: 1, startColumn: 1, ySplit: 1, xSplit: 1 }`), and make it non-editable without protection rules, e.g. override `IAuthzIoService` so that `allowed()` returns `false` for `UnitAction.Edit` (and `true` for `View`/`Copy`), or set `WorkbookEditablePermission` to `false` through `IPermissionService`.
2. Hover the horizontal freeze line in the cell area (e.g. at the bottom edge of D1): the cursor becomes `grab`.
3. Drag it down to row 4 and release: the line stays at row 4; `sheet.command.set-frozen` is executed (with a `BeforeCommandExecute` listener that cancels document mutations, the line stays at row 4 while the model still says row 1).
4. Hover the lower edge of row 1 in the row header (inside the frozen area): the cursor becomes `row-resize`. Drag it down and release: a "no permission" dialog appears. Hovering the edge between rows 5 and 6 (outside the frozen area) shows no handle.

### Expected behavior

- When the workbook is not editable, the freeze line shows no `grab` cursor and cannot be dragged (as `_initFreezePermissionInterceptor()` intends).
- The resize handles behave the same in the frozen and the normal area (no handle when resizing is not allowed).

### Actual behavior

See above: the freeze line can be dragged and stays at the dropped position; in the frozen area the resize handle appears and dragging it ends with a permission dialog.

### Root cause analysis

Paths are relative to the repository root; line numbers refer to tag v1.0.0 (the same code is in 1.0.1 and on `dev` as of 2026-09-29).

- `packages/sheets-ui/src/controllers/permission/sheet-permission-interceptor-canvas-render.controller.ts`: the constructor (L34-51) calls `_initHeaderMovePermissionInterceptor()`, `_initHeaderResizePermissionInterceptor()`, `_initRangeFillPermissionInterceptor()` and `_initRangeMovePermissionInterceptor()`, but not `_initFreezePermissionInterceptor()` (L231-245), which would deny the freeze line when `WorkbookEditablePermission` is not granted.
- `packages/sheets-ui/src/controllers/render-controllers/freeze.render-controller.ts`: `FREEZE_PERMISSION_CHECK` (L109, L150) is checked on pointer enter (L314, L339), pointer down (L486) and pointer move (L519); with no interceptor registered it always returns the initial `true`.
- Frozen-area resize handles, by reading `packages/sheets-ui/src/controllers/render-controllers/header-resize.render-controller.ts`: the permission check is only in the header hover handler (L221-224, L263-266); the handle's own `onPointerEnter$` (L298-308, which shows it and sets the resize cursor) and `onPointerDown$` (L323 onwards) do not check it. 【待补充：为什么只在冻结区域会进入这个控制点，没有深入分析；提交前可以只保留现象】

### Suggested fix

Call `this._initFreezePermissionInterceptor()` in the constructor of `SheetPermissionInterceptorCanvasRenderController`. For the resize handles, check `HEADER_RESIZE_PERMISSION_CHECK` again in the handle's pointer-enter and pointer-down handlers.

### Environment

- Univer: 1.0.1 (`@univerjs/*`), same code in 1.0.0 and on `dev` (2026-09-29). Affected package: `@univerjs/sheets-ui`.
- Browsers: Chromium and WebKit bundled with Playwright 1.63.0, and Google Chrome 153, headless, driven by Playwright.
- OS: macOS 27.0 (Apple silicon).
