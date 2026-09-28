# UR-009 浮动图片所跨的行因自动行高变高后不回写终点锚点，切换工作表或重开时图片被拉伸并被保存

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P2 报告摘要（V03"有条件通过"）、§2.2（DEF-002 用例说明）、§2.3 第 2 条（根因、实测表、补丁规模评估）；用例 `spikes/m0/e2e/v03-drawing-autoheight.spec.ts`（结果 `spikes/m0/e2e/results/v03/drawing-autoheight/*.json`）；延期登记 DEF-002（关联上线门槛 A02）｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：已安装的 1.0.1 发布包中，`@univerjs/sheets-drawing` 的 `REFRESH_MUTATIONS` 仍含两个自动行高 mutation（`lib/es/index.js` L1053–1062），`_refreshDrawingTransform` 对 `Position` 锚点仍只保留宽高、不重算锚点（L2255–2297），`_finalizePlan` 的 refresh 分支仍不产生 mutation（L1236–1245）；`@univerjs/drawing` 的 `refreshTransform` 仍只复制 `transform` 等字段（L229–240）；`@univerjs/sheets-drawing-ui` 在切换工作表与渲染初始化时仍按锚点重算尺寸（L4565、L4228）；另在 1.0.1 上用不含平台代码的最小页面实测复现，Chromium 与 WebKit 结果相同，见正文；npm 上的 1.0.2（当前 latest）代码相同）

## 摘要（中文）

浮动图片使用默认锚点（`Position`：随单元格移动、不随单元格改变大小）时，如果它所跨的某一行因为**自动行高**变高（单元格换行、放大字号、插入单元格图片），SDK 只在内存里保留图片原来的宽高，却不回写终点锚点（`sheetTransform.to`、`axisAlignSheetTransform.to`）。之后凡是按锚点重算的时机——切换到别的工作表再切回来、重新打开文档——图片都会被拉伸到旧锚点所在的位置，而之后的任何一次保存都把拉伸后的尺寸写进快照：这是静默改写内容属性。用显式命令改行高（例如 `setRowHeight`）没有这个问题，因为那条路径会用 mutation 更新锚点。对平台的影响：浮动图片属于 00 号计划书的目标能力，上线门槛 A02 要求"保存、关闭、重开后内容一致"，所以 DEF-002 必须在 M5 修复；改为"已知限制"须走范围变更并经需求方审批。平台的规避：M1 没有开放图片，文档里不会出现浮动图片；M5 优先向上游报告，并以补丁（`pnpm patch`）修正刷新路径（下文 Suggested fix 即补丁候选），备选是平台插件回写锚点（会进撤销栈，并让"打开即自动行高"的文档一打开就有修改，P2 报告 §2.3 第 2 条已评估）。补丁候选的规模这次已经按源码确认：`@univerjs/sheets-drawing` 的 `_refreshDrawingTransform` 加约 5 行（对 `Position` 锚点按保留的尺寸重算两份锚点），`@univerjs/drawing` 的 `refreshTransform` 加 2 行（复制这两个字段）；只在打包产物里临时套用后，在 1.0.1 的最小页面上验证有效（Chromium 与 WebKit：三种触发下尺寸都不变、锚点更新、重开不变，撤销后锚点复原），但没有跑 Univer 自己的测试。验证用例 `v03-drawing-autoheight.spec.ts` 断言的是缺陷特征，修复后要翻转为"尺寸不变、终点锚点已更新"。待补充：StackBlitz 复现链接、`npx envinfo` 输出。

## 已有的上游讨论

没有找到同一问题（2026-09-28 检索 GitHub 的 issue 与 PR，关键词：`image stretched`、`image "row height"`、`floating image size changed`、`drag image`、`sheetTransform`、`image anchor auto height`、`image switch sheet size`；另用 WebSearch 检索网页）。相关但不是同一问题（都针对图片的**位置**，不涉及跨越变高行的图片的锚点与尺寸）：

- [#6376](https://github.com/dream-num/univer/issues/6376) → [#6378](https://github.com/dream-num/univer/pull/6378)（fix: fix auto row height not trigger the update of floating image positions，2025-12-25 合并）：自动行高触发浮动图片位置刷新。
- [#6470](https://github.com/dream-num/univer/issues/6470)、[#6473](https://github.com/dream-num/univer/issues/6473) → [#6498](https://github.com/dream-num/univer/pull/6498)（fix(drawing): fix the incorrect position of floating images，2026-01-21 合并）：刷新监听里 `range` 改为 `ranges` 的参数修正。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Sheets drawing: a floating image is stretched — and the stretched size saved — after auto row height grows the rows it spans (the `to` anchor is never written back)

### Describe the bug

A floating image with the default anchor type (`SheetDrawingAnchorType.Position`: move with cells, don't resize) keeps its size on screen when a row it spans grows because of **auto row height** (wrapped text, a larger font, a cell image). But its anchors — `sheetTransform.to` and `axisAlignSheetTransform.to` — are not updated. Every later recomputation from the anchors then stretches the image to the old anchor cell: switching to another sheet and back, or reopening the workbook. The next `save()` writes the stretched size into the snapshot, so the document is silently changed.

Changing the row height with an explicit command (e.g. `FWorksheet.setRowHeight()`) does not have this problem: that path updates the anchors through a mutation.

### To reproduce

Reproduction link: _to be added (StackBlitz)_. Only public APIs are used.

1. Set up a sheet with the sheets core and sheets drawing presets (1.0.1):

   ```ts
   import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
   import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
   import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing';
   import SheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
   import SheetsDrawingEnUS from '@univerjs/preset-sheets-drawing/locales/en-US';
   import '@univerjs/preset-sheets-core/lib/index.css';
   import '@univerjs/preset-sheets-drawing/lib/index.css';

   const { univerAPI } = createUniver({
       locale: LocaleType.EN_US,
       locales: { [LocaleType.EN_US]: mergeLocales(SheetsCoreEnUS, SheetsDrawingEnUS) },
       presets: [UniverSheetsCorePreset({ container: 'app' }), UniverSheetsDrawingPreset()],
   });
   ```

2. Run the following (`IMAGE_URL` is any 120 × 80 image the page can load, e.g. a file in `public/`):

   ```ts
   const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
   const wb = univerAPI.createWorkbook({
       id: 'autoheight-repro',
       sheetOrder: ['s1'],
       sheets: { s1: { id: 's1', name: 'Data', rowCount: 100, columnCount: 20 } },
   });
   wb.insertSheet('Other');
   const ws = wb.getSheetByName('Data')!;
   wb.setActiveSheet(ws);
   await ws.insertImage(IMAGE_URL, 2, 2); // floating image at C3, 120 × 80, default anchor type
   await wait(1000); // let the sheet render first

   const imageState = () => {
       const data = JSON.parse(wb.save().resources!.find((r) => r.name === 'SHEET_DRAWING_PLUGIN')!.data);
       const image: any = Object.values(data[ws.getSheetId()].data)[0];
       return `${image.transform.width}x${image.transform.height}, to = row ${image.sheetTransform.to.row} + ${image.sheetTransform.to.rowOffset}px`;
   };
   console.log(imageState()); // 120x80, to = row 5 + 8px

   // Grow row 4 (index 3), which the image spans, through auto row height
   ws.getRange('A4').setValue('A long piece of text that wraps inside the cell and makes the row grow via auto row height. '.repeat(2));
   ws.getRange('A4').setWrap(true);
   await wait(1500);
   const snapshotAfterGrow = wb.save();
   console.log(imageState()); // 120x80, to = row 5 + 8px   <- size kept, but the anchor still ends at row 5 + 8px

   wb.setActiveSheet(wb.getSheetByName('Other')!);
   await wait(500);
   wb.setActiveSheet(ws);
   await wait(800);
   console.log(imageState()); // 120x346, to = row 5 + 8px  <- stretched; this is also what save() returns now
   ```

3. Reopen: create a workbook from `snapshotAfterGrow` (saved before switching sheets, still `120x80`) in a fresh Univer instance and read the image again: it is `120x346` there as well, and saving writes that size.

The same should happen through the UI, since it goes through the same auto row height mutation (not re-tested by hand): insert a floating image over C3:D6, type a long text into A4 and turn on text wrapping, then switch to another sheet and back.

### Expected behavior

The image keeps 120 × 80 after row 4 grows, and its `to` anchor (and `axisAlignSheetTransform.to`) is moved to where the image's bottom-right corner now is. Switching sheets, reopening and saving do not change the size — the same result as when the row height is changed explicitly.

### Actual behavior

On 1.0.1 (Chromium 153 and WebKit 26.6 give identical numbers; rows are 0-based):

| Trigger (row 4 = index 3 unless noted) | After the trigger | After switching sheets | Reopening the snapshot saved before switching |
|---|---|---|---|
| wrapped long text in A4 | 120 × 80, `to` = row 5 + 8 | 120 × 346 | 120 × 346 |
| font size 36 in A4 | 120 × 80, `to` = row 5 + 8 | 120 × 111 | 120 × 111 |
| cell image in A3 (`insertCellImageAsync`, 64 × 64) | 120 × 80, `to` = row 5 + 8 | 120 × 99 | 120 × 99 |
| control: `ws.setRowHeight(3, 60)` (explicit command) | 120 × 80, `to` = row 3 + 56 | 120 × 80 | 120 × 80 |

On 1.0.0 we saw the same pattern in Chromium, Chrome and WebKit.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag; the code is unchanged in the published 1.0.1 and 1.0.2 packages.

- `packages/sheets-drawing/src/controllers/sheet-drawing-transform-affected.controller.ts`
  - L100–123 `UPDATE_COMMANDS` vs. L125–134 `REFRESH_MUTATIONS`: auto row height reaches drawings only as `SetWorksheetRowAutoHeightMutation` / `SetWorksheetRowIsAutoHeightMutation` (L131–132), i.e. through the refresh path, not through a command interceptor.
  - L1393–1431 `_sheetRefreshListener()` → L1433–1486 `_refreshDrawingTransform()`: for `Position` anchors the new left/top is computed from the anchors and the old width/height is kept (L1468–1479), but `sheetTransform` / `axisAlignSheetTransform` are left unchanged.
  - L291–342 `_finalizePlan()`, refresh branch L331–339: calls `refreshTransform()` on `ISheetDrawingService` and `IDrawingManagerService` and returns no mutations.
  - For comparison, the explicit path — `_getDrawingUndoForRowAndColSize()` (L764–818) → `_remainDrawingSize()` (L494–504) — recomputes `sheetTransform` and `axisAlignSheetTransform` from the kept transform with `transformToDrawingPosition()` / `transformToAxisAlignPosition()` (`packages/sheets-drawing/src/basics/transform-position.ts` L56–70, L81–103) and emits a mutation.
- `packages/drawing/src/services/drawing-manager-impl.service.ts` L285–309 `UnitDrawingService.refreshTransform()` copies only `transform`, `transforms`, `isMultiTransform`, `behindText` and `hidden`, so recomputed anchors could not be written back through this path anyway.
- Anchors are turned back into a size in two places, which is where the stretch appears:
  - `packages/sheets-drawing-ui/src/controllers/sheet-drawing-active-render.controller.ts`: on `SetWorksheetActiveOperation` (L38–46), `_updateDrawings()` (L82–116) sets `drawing.transform = drawingPositionToTransform(drawing.sheetTransform, …)` (L100–102);
  - `packages/sheets-drawing-ui/src/controllers/render-controllers/sheet-drawing.render-controller.ts` L39–70 does the same on render initialization, i.e. when the workbook is opened (L50–64).
- Related history: #6378 made auto row height refresh floating image positions, and #6498 fixed the `ranges` parameter of the refresh listener; both are about the position of images below the grown rows. This report is about images whose anchor range spans the grown rows.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0; the code above is unchanged in 1.0.2 (latest on npm on 2026-09-28).
- Affected packages: `@univerjs/sheets-drawing` (refresh path), `@univerjs/drawing` (`refreshTransform`), `@univerjs/sheets-drawing-ui` (recomputation from anchors).
- Browsers: Chromium 153.0.8010.12 (Playwright build), WebKit 26.6 (Playwright build), headless via Playwright 1.63.0; on 1.0.0 also Google Chrome 153.0.8010.53.
- OS: macOS 27.0 for the 1.0.1 runs, macOS 26.5.1 for the 1.0.0 runs (Apple M4 Pro).

### Suggested fix

The refresh path should keep the anchors consistent with the size it keeps — the same thing `_remainDrawingSize()` already does for explicit row/column size commands:

1. In `_refreshDrawingTransform()`, for `Position` anchors, derive new anchors from the kept-size transform:

   ```ts
   const isPositionAnchor = anchorType === SheetDrawingAnchorType.Position;
   const newTransform = drawingPositionToTransform(sheetTransform, sheetSkeletonParam);
   const nextTransform = {
       ...transform,
       left: newTransform?.left,
       top: newTransform?.top,
       width: isPositionAnchor ? transform?.width : newTransform?.width,
       height: isPositionAnchor ? transform?.height : newTransform?.height,
   };
   const next: ISheetDrawing = { ...drawing, transform: nextTransform };
   if (isPositionAnchor && sheetSkeletonParam) {
       // keep the size, move the far anchor instead (as _remainDrawingSize() does)
       next.sheetTransform = transformToDrawingPosition({ ...nextTransform }, sheetSkeletonParam.skeleton);
       next.axisAlignSheetTransform = transformToAxisAlignPosition({ ...nextTransform }, sheetSkeletonParam.skeleton);
   }
   updateDrawings.push(next);
   ```

   `_finalizePlan()` already carries `sheetTransform` / `axisAlignSheetTransform` of the update into the plan (L321–327), and the change check at L332 will see the new anchors.
2. Write the anchors back in the refresh branch of `_finalizePlan()` (L331–339). Either
   - let `UnitDrawingService.refreshTransform()` also copy `sheetTransform` / `axisAlignSheetTransform` when the update carries them — it already copies the docs-specific `behindText` in the same way; or
   - keep `@univerjs/drawing` untouched and assign the two fields to the drawing models of `ISheetDrawingService` / `IDrawingManagerService` right after `refreshTransform()` in the sheet controller.
3. Whether the refresh should stay local (no mutation, as today) is a design decision. Staying local looks consistent: the refresh reacts to the row-height mutations themselves, so wherever the same row heights are applied the same anchors are derived; undoing the text change restores the row height and runs the refresh again; and the anchors are persisted by the next save. Emitting a mutation from the refresh would put a derived change into the undo stack and into collaboration traffic.
4. Regression tests: for wrapped text, a larger font and a cell image under a `Position`-anchored image, the size stays unchanged and the `to` anchor moves, after the trigger, after switching sheets and after reopening; `Both` anchors keep resizing with the rows.

We tried items 1 and 2 (first option: two extra `in` checks in `refreshTransform()`) as a local patch on the 1.0.1 packages in our minimal page. In Chromium 153 and WebKit 26.6 the image kept 120 × 80 after the trigger, after switching sheets and after reopening, for all three triggers; the `to` anchor moved (wrapped text: row 3 + 56, font size 36: row 4 + 1, cell image: row 4 + 13); undoing the wrap moved it back to row 5 + 8; the explicit-command control was unaffected. We have not run Univer's own test suites against the change.
