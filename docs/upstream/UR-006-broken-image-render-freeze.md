# UR-006 图片读取失败时渲染对破损图片调用 drawImage，抛出 InvalidStateError 并让画布停止刷新

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P4 报告摘要"读取失败时 SDK 会抛出未捕获的异常"、§2.2（D5 的说明与"读取失败时的页面错误"表）、§2.3 第 3 条；用例 `spikes/m0/e2e/v11-assets.spec.ts`（"V11 读取失败时返回占位图"，结果 `spikes/m0/e2e/results/v11/fallback/*.json`）与 `spikes/m0/e2e/v11-image-paths.spec.ts`（D5、D6、D8b、D8d 的默认配置，结果 `spikes/m0/e2e/results/v11/paths/`）；P4 交接单"上游报告"第 1 条；没有 DEF 编号｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：已安装的 `@univerjs/engine-render@1.0.1` 发布包 `lib/es/index.js` 中，`Image` 类的构造函数仍是先挂 `onerror` 换内置 SVG（L32335）、`_drawNative`（L32536 起）的 4 处 `ctx.drawImage(native, …)`（L32551、L32552、L32565、L32566）仍不检查图片状态，`changeSource`（L32391）仍没有错误处理，`Engine` 的 `_renderFunction`（L34809–34819）仍不捕获异常、渲染完才请求下一帧；另在 1.0.1 上用不含平台代码的最小页面实测复现，见正文 Actual behavior；npm 上的 1.0.2（当前 latest）代码相同）

## 摘要（中文）

浮动图片（以及文字文档里的图片）的地址读不到时——被页面 CSP 拦截、返回 401/404、网络失败、数据损坏——渲染引擎的 `Image` 形状会在浏览器派发 `error` 事件、SDK 把它换成内置占位图之前，对这张处于"破损"状态的 `<img>` 调用 `drawImage`，浏览器按规范抛出 `InvalidStateError`。M0 只把它记成"未捕获的异常"；这次在 1.0.1 上复核发现后果更重：异常从渲染循环里抛出后，`Engine` 不再请求下一帧，整块画布从此不再刷新（滚动、选区、输入都画不出来），只能刷新页面。在 Chromium 内核上，CSP 拦截图片地址时几乎每次都触发（最小页面 Chromium 15 次加载 15 次、Google Chrome 3 次 2 次；WebKit 4 次都没有触发），读取返回 401 时是概率性的（M0 在 1.0.0 上 9 次 5 次）。对平台的影响：M5 开放图片后，会话过期、截断或损坏的图片、网络中断、离线都可能让用户面对一张"冻住"的表格。平台的规避：M1 没有开放图片（菜单隐藏、命令守卫，文档里不会出现图片）；M5 按 P4 方案让服务端在读取失败时返回平台占位图（200），并以严格 CSP、默认拒绝的粘贴清洗与服务端校验保证文档里只有同源地址——这能挡住 CSP 拦截与服务端能应答的失败，但挡不住截断图片、网络失败与离线，所以建议 M5 同时以补丁（`pnpm patch`）给 `Image` 加破损检查。待补充：StackBlitz 复现链接、`npx envinfo` 输出、Firefox 与真实 Safari 的结果。

## 已有的上游讨论

没有找到同一问题（2026-09-28 检索 GitHub 的 issue 与 PR，关键词：`drawImage`、`InvalidStateError`、`"broken" image`、`"broken state"`、`image 404`、`image load error render`、`onerror image`、`float image fail load`、`"Failed to execute 'drawImage'"`、`canvas freeze image`；另用 WebSearch 检索网页）。相关但不是同一处：[#4388](https://github.com/dream-num/univer/pull/4388)（fix: canvas crash when draw broken image，2024-12-30 合并）与 [#5459](https://github.com/dream-num/univer/pull/5459)（fix(engine-render): handle broken image state in font rendering，2025-06-28 合并）只修了表格**单元格图片**的绘制（`components/sheets/extensions/font.ts`）；浮动图片与文字文档图片走的 `shape/image.ts` 没有同样的保护。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] engine-render: drawing a broken `<img>` (CSP-blocked / HTTP 4xx) throws `InvalidStateError` in `Image` and stops the render loop

### Describe the bug

When the URL of a floating image (sheets) or of a document drawing cannot be loaded — it is blocked by the page's Content-Security-Policy, the server answers 401/404, the network fails, or the data is corrupt — the `Image` shape of `@univerjs/engine-render` can call `CanvasRenderingContext2D.drawImage()` with an `HTMLImageElement` that is in the *broken* state. Per the HTML spec, `drawImage()` throws an `InvalidStateError` for a broken image ("The HTMLImageElement provided is in the 'broken' state.").

The exception is not caught anywhere in the render pipeline. It escapes `Engine._renderFunction()` before the next animation frame is requested, so the engine's render loop stops: from then on the canvas is not repainted any more (scrolling, selection changes and edits are not drawn); in a page with one workbook this lasts until the page is reloaded. The built-in placeholder SVG that `Image` switches to on `error` is never painted either.

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

2. Add a Content-Security-Policy that blocks third-party images to `index.html` (any policy that blocks the image URL used below will do):

   ```html
   <meta http-equiv="Content-Security-Policy" content="img-src 'self' data: blob:">
   ```

3. Create a workbook with one floating image whose URL is blocked by that policy:

   ```ts
   const unitId = 'broken-image-repro';
   const sheetId = 'sheet-1';
   const anchor = {
       from: { row: 2, column: 2, rowOffset: 0, columnOffset: 0 },
       to: { row: 5, column: 3, rowOffset: 8, columnOffset: 32 },
       flipX: false, flipY: false, angle: 0, skewX: 0, skewY: 0,
   };
   univerAPI.createWorkbook({
       id: unitId,
       sheetOrder: [sheetId],
       sheets: { [sheetId]: { id: sheetId, name: 'Sheet1', rowCount: 200, columnCount: 20 } },
       resources: [{
           name: 'SHEET_DRAWING_PLUGIN',
           data: JSON.stringify({
               [sheetId]: {
                   order: ['img1'],
                   data: {
                       img1: {
                           unitId,
                           subUnitId: sheetId,
                           drawingId: 'img1',
                           drawingType: 0, // DrawingTypeEnum.DRAWING_IMAGE
                           imageSourceType: 'URL',
                           source: 'https://example.invalid/picture.png',
                           sheetTransform: anchor,
                           axisAlignSheetTransform: anchor,
                           transform: { left: 222, top: 68, width: 120, height: 80, angle: 0, flipX: false, flipY: false, skewX: 0, skewY: 0 },
                       },
                   },
               },
           }),
       }],
   });
   ```

4. Look at the console, then scroll the sheet, click a few cells and type a value.

Without the CSP (image URL answering 401/404 instead), the same exception happens intermittently: it depends on whether a frame is rendered after the `<img>` became broken and before its `error` event (see root cause).

### Expected behavior

An image that fails to load is painted as a placeholder (both `Image` and the sheet cell-image renderer already ship one) or not painted at all. Rendering never throws because of an image that failed to load, and one failing object never stops the whole canvas from being rendered.

### Actual behavior

- The console shows `Uncaught InvalidStateError: Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The HTMLImageElement provided is in the 'broken' state.` (WebKit: `InvalidStateError: The HTMLImageElement provided is in the 'broken' state.`).
- From then on the canvas is not repainted: scrolling, selection and typed values are not drawn. The engine's frame counter (`Engine._frameId`) stops increasing while `_renderingQueueLaunched` stays `true`.
- Our runs on 1.0.1, one fresh page per run (a minimal page on the `@univerjs/*` packages, no application code):

  | Setup | Chromium 153 | Google Chrome 153 | WebKit 26.6 |
  |---|---|---|---|
  | CSP blocks the image URL (steps above; as a response header or a `<meta>` tag, with or without scrolling) | threw in 15 of 15 loads | 2 of 3 | 0 of 4 |
  | After the exception | canvas never repainted again (every time) | same | — |

- On 1.0.0 (our earlier test app, image URL answering 401, no CSP involved) the exception appeared in 5 of 9 page loads (Chromium 1/3, Chrome 2/3, WebKit 2/3). In documents, external images that were pasted and then blocked by CSP threw the same exception in Chromium and Chrome.
- To check the consequence independently of the timing, we also added an `Image` shape whose `<img>` was already broken to the sheet scene (test-only, through internal services): on the next frame both Chromium 153 and WebKit 26.6 threw the same `InvalidStateError`, and the canvas stopped repainting.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag; the code is unchanged in the published 1.0.1 and 1.0.2 packages.

1. `packages/engine-render/src/shape/image.ts`
   - L147–164: when an `Image` is created with `url`, the constructor creates an `<img>`, sets `crossOrigin`, an `onload`, and an `onerror` (L155–163) that swaps `src` for a built-in SVG data URL (or calls `config.fail()` if given), then assigns `src` (L164).
   - L476–535 `_drawNative()`: calls `ctx.drawImage(native, …)` (L502, L510, L525, L533) without checking the state of `native`. For an image that is still loading, `drawImage()` just draws nothing; for a *broken* image it throws.
   - The `onerror` fallback only helps after the `error` event handler has run. In practice a frame can still be rendered after the element has become broken and before that handler runs (the exceptions above can only happen that way), and nothing protects that frame. In our tests this window was hit on almost every load in Chromium when the URL was blocked by CSP.
   - `changeSource()` (L228–236), which `ImageUpdateController` calls on drawing updates such as move/resize (`packages/drawing-ui/src/controllers/image-update.controller.ts` L258–261), re-assigns `src` without any error handling, so the same window opens again for an image whose URL keeps failing. If a caller passes `fail`, the element is never switched to the placeholder and stays broken, so every frame would throw.
   - For comparison, the sheet cell-image renderer already guards the same call (`packages/engine-render/src/components/sheets/extensions/font.ts` L146–154 and L501–516: `complete` / `data-error` checks plus try/catch, from #4388 and #5459), and `DrawingRenderService` only reuses cached elements that are `complete && naturalWidth > 0` (`packages/drawing-ui/src/services/drawing-render.service.ts` L72–74). The path through the `Image` shape — floating images in sheets and drawings in docs, created in `drawing-render.service.ts` L187 — has no such guard.
2. `packages/engine-render/src/engine.ts`
   - L443–461 `_renderFunction`: calls `_renderFrame()` (L453; for sheets this runs `scene.render()`, registered in `packages/sheets-ui/src/controllers/render-controllers/sheet.render-controller.ts` L92–96) without try/catch, and requests the next frame only afterwards (L457–458). When a render throws, no further frame is requested.
   - L421–428 `startRenderLoop()`: `_renderingQueueLaunched` is still `true`, so later `runRenderLoop()` calls do not restart the loop. Only `stopRenderLoop()` emptying the task list resets the flag (e.g. when the render unit is deactivated), so with a single workbook on the page rendering stays stopped until reload.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0; the code above is unchanged in 1.0.2 (latest on npm on 2026-09-28).
- Affected package: `@univerjs/engine-render` (`Image` shape and the `Engine` render loop).
- Browsers: Chromium 153.0.8010.12 (Playwright build), Google Chrome 153.0.8010.53, WebKit 26.6 (Playwright build), all headless via Playwright 1.63.0. Firefox was not tested.
- OS: macOS 27.0 for the 1.0.1 runs, macOS 26.5.1 for the 1.0.0 runs (Apple M4 Pro).

### Suggested fix

1. In `Image._draw()` / `_drawNative()`, do not call `drawImage()` unless the element is usable — for example `native.complete && native.naturalWidth > 0` (a broken image is `complete` with `naturalWidth === 0`) — and paint the placeholder (or nothing) otherwise, repainting on `load` / `error`. A try/catch around `drawImage()`, as `font.ts` does, would also avoid the exception.
2. Give `changeSource()` the same error handling as the constructor.
3. Make the render loop resilient: run `_renderFrame()` inside `try/finally` (or request the next frame before rendering) and report the error, so that one failing object cannot stop all further rendering.
