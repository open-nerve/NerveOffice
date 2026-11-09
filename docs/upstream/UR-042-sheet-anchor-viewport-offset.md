# UR-042 浮图终点锚点混入视口的滚动与缩放

状态：本项目已在固定的 `@univerjs/core@1.0.1` 补丁中修正（DEF-081，ADR-022 的 M5-P8 补充）；未发送上游。发现于 M5-P8 S6 原生补验（真实 Safari，2026-11-09）。

## 现象

表格向下滚动之后插入浮图，存下的 `sheetTransform.to` 与 `axisAlignSheetTransform.to` 不对：终点行多出滚动的行数，行内偏移为负。真实 Safari 中三张图分别存成“第 26 行 −336 像素”“第 32 行 −312 像素”“第 36 行 −312 像素”，应为“第 12/18/22 行 +0”。换算回绝对位置恰好等于正确值，所以当下显示正常；之后在受影响范围内插入、删除行列或改行高列宽，图片会跳位或拉伸。视口缩放不是 100% 时同样出错。移动、拖拽缩放、翻转与图片的复制粘贴经同一个换算，也会存下偏了的锚点。

## 根因

`SheetSkeleton.getCellIndexAndOffsetByPosition(offsetX, offsetY)`（core；engine-render 的 `SpreadsheetSkeleton` 继承）按 `getCellWithCoordByOffset(offsetX, offsetY, this._scaleX, this._scaleY, { x: this._scrollX, y: this._scrollY })` 找格，即把参数当作视口坐标：先除以缩放、再加上滚动量；随后的格内偏移却是 `offsetY - startY`、`offsetX - startX`，没有滚动与缩放。两处不一致。

它在 SDK 里只有两个调用方，传入的都是工作表绝对坐标（含行列表头）：

- `convertPositionCellToSheetOverGrid`（sheets）：插入浮图；
- `transformToDrawingPosition`（sheets-drawing）：移动、拖拽缩放、翻转、图片复制粘贴。

视口滚动由 sheets-ui 的滚动管理经 `setScroll` 写入骨架，缩放经 `setScale` 写入，所以只要视口滚动过或缩放过，存下的锚点就随当时的视口变化。

## 修正与验证

把找格改为按绝对坐标：`getCellWithCoordByOffset(offsetX, offsetY, 1, 1, { x: 0, y: 0 })`，与格内偏移一致；文档注释同步改为“绝对坐标”。只改 ES 发布入口，补丁与摘要见 `patches/univer-images.json`。

真实 SDK 回归（`apps/web/src/editor/internal-api/image-anchor-regression.test.ts`）覆盖纵向滚动、横向滚动、放大 200%、滚动并缩小到 50%：两个换算函数与产品插入路径存下的两份锚点，必须与未滚动、未缩放时相同。未修正时 8 条全部失败，修正后通过。正式入口的浏览器故事见 `tests/e2e/specs/editor/image-production.spec.ts` 的 DEF-081 用例。

上游修复同一换算（或改为由调用方按视口坐标传入并同步修改两个调用方）之后，须通过上述回归与浏览器故事，再移除本段补丁。
