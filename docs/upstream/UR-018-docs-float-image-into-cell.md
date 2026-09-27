# UR-018 浮动图片可以拖进单元格，再改为内联

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P5 报告 §1.2 第 5 条、§2.3 第 3 条、§6"上游报告"第 8 条；审查报告 R3；用例 `spikes/m0/e2e/v13-capabilities.spec.ts`（C5b"单元格里插入图片"，结果 `spikes/m0/e2e/results/v13/capabilities/*-C5b-default.json`、`*-C5b-platform.json`）；平台守卫 `spikes/m0/src/harness/doc-policy.ts`；没有 DEF｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：`@univerjs/docs-drawing-ui` 本机没有安装 1.0.1，用 npm 上的发布包核对（`npm pack @univerjs/docs-drawing-ui@1.0.1`，shasum 5a791be4…）：拖动后的锚点计算仍有 `page.type === DocumentSkeletonPageType.CELL` 分支，并直接执行 `doc.command.transform-non-inline-drawing`，移动锚点的 `getDeleteAndInsertCustomBlockActions` 里没有任何表格判断，工具栏的图片按钮仍只在表格里禁用；已安装的 `@univerjs/docs-drawing@1.0.1` 里 `doc.command.update-doc-drawing-wrapping-style` 仍不检查锚点是否在单元格里；1.0.2 同样；GitHub dev 分支上的拖动控制器与环绕方式命令自 2026-09-22 起没有新提交）

## 摘要（中文）

文字文档的工具栏在光标位于表格里时禁用"插入图片"（源码注释写着单元格暂不支持绘图），但一张浮动图片（例如"四周型"环绕）可以绕进单元格：拖动时 SDK 按图片左上角所在的位置计算新锚点，落在单元格里就把图片的锚点（正文里的 `\b`）移进单元格；再把环绕方式改为"嵌入型"，就得到单元格里的内联图片。段落菜单、`/` 菜单的"插入图片"与粘贴图片文件也能把图片放进单元格，属于同一类不一致，正文里一并说明。对用户与平台：这条路径绕过了 00 号计划书 §4.3 的"单元格里不放图片"；平台在 M0 验证工程里用命令守卫落实这条规则——取消目标在表格里的 `doc.command.transform-non-inline-drawing`、锚点在表格里改为内联的 `doc.command.update-doc-drawing-wrapping-style`，以及在单元格里插入图片、移动内联图片的命令，粘贴清洗去掉粘贴进单元格的图片；这些守卫依赖内部命令 id 与参数（插件档案 v1 §7 已登记），生产实现在 M6。证据状况：入库的是平台配置下的记录——三个浏览器里用真实鼠标拖动后，SDK 发出的 `doc.command.transform-non-inline-drawing` 的 `offset` 落在表格第一个单元格里（被守卫取消）；SDK 默认配置下"拖进单元格 → 改为内联"的完整复现来自审查时的临时探针（审查报告 R3，未入库）。注意：C5b 在 SDK 默认配置下记录的 `anchorInCell: true` 不能当作证据——它的判定是"任一图片的锚点在表格里"，而那次用例里此前已有两张图片经命令与粘贴放进了单元格；那次的快照显示被拖动的浮动图片锚点仍在表格之外（正文"段落乙"之后仍有一个 `\b`，另外两个 `\b` 在单元格里，对应经命令与粘贴放进去的两张内联图片；浮动图片的位置偏移也仍是插入时的 0,0），看起来那次拖动没有作用在浮动图片上（可能抓到了单元格里那张同样是蓝色的图片），报告 §2.3 第 3 条里"SDK 默认下……拖进来的浮动图片，保存重开都一致"这半句同样缺少证据。提交前需要在 SDK 默认配置下重跑并补截图与 StackBlitz 复现链接（待补充）。另外，上游 [#7387](https://github.com/dream-num/univer/pull/7387) 修复了"插入到单元格末尾的图片不渲染"，说明上游在 API 路径上把单元格里的图片当作要支持的数据，所以正文把期望写成"请明确策略，并让各条路径一致"。

## 已有的上游讨论

没有找到针对"浮动图片拖进单元格、再改为内联"的 issue 或 PR（GitHub issue 检索，关键词：`docs image table cell`、`image in table cell doc`、`image in table`、`drawing in table cell`、`drawing anchor table cell`、`drag image into table`、`drag floating image`、`float image table`、`inline image table cell`、`insert image table disabled`、`wrapping style inline table`、`transform-non-inline-drawing`、`"cell support drawing"`、`文档 表格 图片`、`浮动图片 表格`；另用 WebSearch 检索网页；2026-09-28）。相关：[#7387](https://github.com/dream-num/univer/pull/7387)（fix(docs): render images inserted at table cell tail，2026-07-31 合并：把插入到单元格结构尾部的图片规范到段落终止符之前，使其可以渲染）；[#7388](https://github.com/dream-num/univer/pull/7388)（fix(docs): preserve drawing drag positions across layouts，2026-08-01 提出，已关闭，与表格无关）；[#3719](https://github.com/dream-num/univer/pull/3719)（fix(docs): insert image after table，2024 年，已关闭，无关）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Docs: a floating image can be dragged into a table cell and then set to "In line with text", although Insert Image is disabled inside tables

### Describe the bug

While the caret is inside a table, the toolbar **Image** button is disabled (`getDisableWhenSelectionInTableObservable`, commented `TODO: @Jocs, remove this when cell support drawing.`), so drawings inside table cells look unsupported. A floating image can still end up inside a cell:

1. Drag a floating image (e.g. wrapping **Square**) so that its top-left corner is over a table cell. The new anchor is computed from the node under that corner; when it is a paragraph inside the cell, `doc.command.transform-non-inline-drawing` moves the image's custom block (`\b`) into the cell.
2. Switch that image to **In line with text**. `doc.command.update-doc-drawing-wrapping-style` has no table check, so the result is an inline image inside the cell.

Related entry points with the same inconsistency: the **Insert Image** item of the paragraph menu and of the `/` menu runs the same `doc.command.insert-float-image` command but has no table-disabled state — executing that command with the caret in a cell inserts the image into the cell — and pasting an image file into a cell inserts it as well.

### To reproduce

Reproduction link: 【待补充：提交前把下面的片段放进官方 StackBlitz 模板（改用 Docs 预设），生成复现链接】

Screenshots: 【待补充：SDK 默认配置下第 5–7 步的截图或录屏】

1. Set up a document editor with the Docs core and Docs drawing presets (1.0.1):

   ```ts
   import { createUniver, getDocsEmptySnapshot, LocaleType, mergeLocales } from '@univerjs/presets';
   import { UniverDocsCorePreset } from '@univerjs/preset-docs-core';
   import DocsCoreEnUS from '@univerjs/preset-docs-core/locales/en-US';
   import { UniverDocsDrawingPreset } from '@univerjs/preset-docs-drawing';
   import DocsDrawingEnUS from '@univerjs/preset-docs-drawing/locales/en-US';
   import '@univerjs/preset-docs-core/lib/index.css';
   import '@univerjs/preset-docs-drawing/lib/index.css';

   const { univerAPI } = createUniver({
       locale: LocaleType.EN_US,
       locales: { [LocaleType.EN_US]: mergeLocales(DocsCoreEnUS, DocsDrawingEnUS) },
       presets: [UniverDocsCorePreset({ container: 'app' }), UniverDocsDrawingPreset()],
   });
   univerAPI.createDocument(getDocsEmptySnapshot());
   ```

2. Type a line of text, press Enter, then **Insert → Table → Insert Table** (2 × 2), so that there is a paragraph above the table.
3. Put the caret in the first paragraph and insert a PNG with the toolbar **Image** button. (With the caret inside the table this button is disabled.)
4. Click the image and choose the wrapping **Square** in its floating toolbar.
5. Drag the image and drop it so that its top-left corner is inside a table cell.
6. Check where the image is anchored:

   ```js
   const snap = univerAPI.getActiveDocument().save();
   const table = snap.body.tables[0];
   console.table(snap.body.customBlocks.map((b) => ({
       drawingId: b.blockId,
       anchorInTable: b.startIndex > table.startIndex && b.startIndex < table.endIndex,
       layoutType: snap.drawings[b.blockId].layoutType, // 3 = WRAP_SQUARE, 0 = INLINE
   })));
   ```

   → `anchorInTable: true`, `layoutType: 3`.
7. Click the image and choose **In line with text**; run the snippet again → `anchorInTable: true`, `layoutType: 0`: the image is now an inline image inside the table cell.

### Expected behavior

A consistent policy for drawings in table cells:

- If drawings in cells are not supported yet (as the disabled toolbar button and its TODO say): dropping a floating image over a table should not move its anchor into a cell (keep it in a paragraph outside the table, or refuse the move); switching a drawing anchored in a cell to inline should be refused; and the paragraph-menu / `/`-menu item and pasting image files should follow the same rule.
- If drawings in cells are supported (the renderer now handles images inserted into cells, see #7387): lift the toolbar restriction, remove the TODO and document the behavior.

Either way, a single option to disallow drawings in table cells would help integrators that need that rule.

### Actual behavior

- After step 5 the image's anchor is inside the table cell. With a `BeforeCommandExecute` listener we can see the drop emit `doc.command.transform-non-inline-drawing` whose `offset` is inside the table (the content start of the first cell in our document) — observed with real mouse events (Playwright `mouse.down/move/up`) in Chromium, Chrome and WebKit.
- After step 7 the image is an inline image inside the cell.
- For reference, inline images that got into cells through `doc.command.insert-float-image` or by pasting an image file survived save and reopen in our tests; the problem is the inconsistency with the toolbar, not data loss.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag.

- `packages/docs-drawing-ui/src/menu/image.menu.ts`: only the toolbar item (`ImageMenuFactory`, L64–74) gets the table-disabled state from `getDisableWhenSelectionInTableObservable()` (L29–62, with the TODO); the paragraph-menu items `UploadFloatImageMenuFactory` / `UploadFloatImageBelowMenuFactory` (L76–98) run the same command without it.
- `packages/docs-drawing-ui/src/controllers/doc-drawing-transformer-update.controller.ts`
  - `_nonInlineDrawingTransform()` (L868–891): after a drag, takes the new anchor from `_getDrawingAnchor()` and executes `ITransformNonInlineDrawingCommand` with its `offset`.
  - `_getDrawingAnchor()` (L505–741): hit-tests the drawing's top-left corner (`findNodeByCoord`, L555–559); when that node lies in a table cell, the `DocumentSkeletonPageType.CELL` branch (L583–584, `getDocsTableCellAnchorContext()` at L78–94) keeps it as the anchor and its offset is returned (L733–740).
- `packages/docs-drawing-ui/src/commands/commands/update-doc-drawing.command.ts`: `ITransformNonInlineDrawingCommand` (L444–555) moves the custom block with `getDeleteAndInsertCustomBlockActions()` (L37–183), which deletes the `\b` and inserts it at `offset`; the only adjustment is clamping to `dataStream.length - 2`, there is no table check.
- `packages/docs-drawing/src/commands/commands/update-doc-drawing-wrapping-style.command.ts` L93–168: the only guard is that non-inline styles are refused for drawings in a header/footer segment (L112–114); switching a drawing anchored in a table cell to `INLINE` is allowed.

The same code is present in the published 1.0.1 and 1.0.2 packages (`@univerjs/docs-drawing-ui`, `@univerjs/docs-drawing`).

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. The runtime observations were made on 1.0.0; the code quoted above is unchanged in the published 1.0.1 and 1.0.2 packages.
- Browsers: Chromium 153.0.8010.12 (Playwright build), Google Chrome 153.0.8010.53, WebKit 26.6 (Playwright build) — headless via Playwright 1.63.0, dragging with real mouse events.
- OS: macOS 26.5.1 (Apple M4 Pro)

### Suggested fix

- Decide whether drawings in table cells are supported, and apply the decision in one shared check ("is this offset inside a table cell?") used by insert, move, transform, wrapping style and paste.
- If they are not supported: in `_getDrawingAnchor()` do not pick an anchor on a `CELL` page for floating drawings (fall back to a paragraph outside the table, e.g. the one before it), and make `UpdateDocDrawingWrappingStyleCommand` refuse `INLINE` when the drawing's custom block is inside a table; also give the paragraph-menu items the same disabled state as the toolbar button.
- If they are supported: remove the table-disabled state from the toolbar item together with its TODO.
