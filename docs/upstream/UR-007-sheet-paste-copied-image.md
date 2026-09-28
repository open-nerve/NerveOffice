# UR-007 表格粘贴"浏览器复制图片"（图片文件 + 只有外链 `<img>` 的 HTML）时图片丢失

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P4 报告摘要"SDK 的几处可用性缺口"、§2.2 路径矩阵 S5c、§2.3 第 5 条；用例 `spikes/m0/e2e/v11-image-paths.spec.ts`（S5c，结果 `spikes/m0/e2e/results/v11/paths/*-S5c-paste-file-and-html-*.json`）；P4 交接单"上游报告"第 2 条；相关的真实剪贴板复核是 DEF-004｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：已安装的 `@univerjs/sheets-ui@1.0.1` 发布包 `lib/es/index.js` 中，`htmlContainsImage` 仍只认 base64 的 `<img>`（L3944–3947），`paste()` 与 `legacyPaste()` 的 `shouldUseHTMLPaste` 规则不变（L4231、L4261）；另在 1.0.1 上用不含平台代码的最小页面实测复现，Chromium 与 WebKit 结果相同，见正文；npm 上的 1.0.2（当前 latest）代码相同）

## 摘要（中文）

在浏览器里对网页图片点"复制图片"后，剪贴板里同时有一张图片（`image/png`）和一段只有外链 `<img src="https://…">` 的 HTML。把它粘贴到表格时，SDK 只要 HTML 里没有 base64 图片就按 HTML 粘贴，而 HTML 转换会丢掉 `<img>`，图片文件被忽略：什么都没插入，也没有任何提示，用户以为粘贴失败或剪贴板是空的。只有图片文件时能正常插入浮动图片，文字文档同样的情形会插入图片。键盘粘贴路径的这个规则来自上游 2026-09-20 合并的 #7712（PR 没有说明，从改动看针对的应是"电子表格软件同时放表格 HTML 与选区截图"的情形），所以 1.0.0 起就是这样；右键菜单走的异步剪贴板路径更早就是同一规则。平台的规避：M1 没有开放图片，粘贴图片文件本来就不产生图片（命令守卫，E2E 锁定）；M5 计划在平台的粘贴钩子里判断"HTML 只有图片、同时有图片文件"，改为粘贴文件（P4 报告 §2.3 第 5 条）。证据状况：M0 与这次复核都用合成的 `paste` 事件（与快捷键粘贴同一路径），剪贴板内容按 Chromium"复制图片"的形态构造；真实剪贴板与真实 Safari 的复核仍是 DEF-004。待补充：StackBlitz 复现链接、`npx envinfo` 输出、真实浏览器"复制图片"后的剪贴板类型记录。

## 已有的上游讨论

没有找到同一问题（2026-09-28 检索 GitHub 的 issue 与 PR，关键词：`htmlContainsImage`、`paste image sheet`、`"copy image"`、`paste picture`、`clipboard image html`、`paste image html img`；另用 WebSearch 检索网页）。相关：

- [#7712](https://github.com/dream-num/univer/pull/7712)（fix(sheets-ui): improve external clipboard paste，2026-09-20 合并，已包含在 1.0.0 中）：把 `legacyPaste` 从"有文件且 HTML 不是来自 Excel 就粘贴文件"改成"HTML 优先，除非 HTML 里有 base64 图片"。这正是键盘粘贴路径出现本问题的来源。
- [#3617](https://github.com/dream-num/univer/pull/3617)（feat(float-image): support paste image from external，2025-01-21 合并，关闭 [#2623](https://github.com/dream-num/univer/issues/2623)）：引入外部图片粘贴。
- [#7611](https://github.com/dream-num/univer/pull/7611)（feat(clipboard): support external rich content and images，2026-08-28 合并）：在 `@univerjs/drawing-ui` 新增了 `isImageOnlyClipboardHtml()` 等工具，只用于文字文档，表格没有使用。
- [#6617](https://github.com/dream-num/univer/pull/6617)（fix(docs): fixed insertion of pictures from other sites with clipboard，打开中）：只涉及文字文档。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Sheets: pasting an image copied with the browser's "Copy image" inserts nothing (the image file is ignored when the HTML only contains an `<img src="https://…">`)

### Describe the bug

When the clipboard holds an image file together with an HTML fragment that contains nothing but an `<img>` with an http(s) `src`, pasting into a sheet inserts nothing — no floating image, no cell content, no message. This is what the clipboard looks like after the context-menu command "Copy image" in Chromium-based browsers: an image plus the HTML `<img src="…" alt="…">`.

`SheetClipboardService` pastes the HTML unless the HTML contains a *base64* `<img>`. The HTML-to-cells conversion drops the `<img>`, and the image file is never used. Pasting the same image file without HTML inserts a floating image as expected, and in Univer Docs the same clipboard content does insert the image (checked on 1.0.0).

### To reproduce

Reproduction link: _to be added (StackBlitz)_. Only public APIs are used.

1. Set up a sheet with the sheets core and sheets drawing presets (1.0.1), and expose the API for the console:

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
   univerAPI.createWorkbook({});
   (window as any).univerAPI = univerAPI;
   ```

2. Manually: in Chrome, right-click an image on any web page → **Copy image**. Click cell C3 of the sheet and press Ctrl/Cmd+V. Nothing is inserted. (We verified this clipboard content with the synthetic paste in step 3; a recording of a real "Copy image" clipboard is still to be added.)
3. Deterministic check: click cell C3 (the cell editor's hidden input is then `document.activeElement`; dispatching `paste` there is the same code path as Ctrl/Cmd+V) and run in the DevTools console:

   ```js
   const canvas = document.createElement('canvas');
   canvas.width = 120; canvas.height = 80;
   canvas.getContext('2d').fillRect(0, 0, 120, 80);
   const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

   const dt = new DataTransfer();
   dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
   dt.setData('text/html', '<meta charset="utf-8"><img src="https://example.com/photo.png" alt="photo">');
   document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

   setTimeout(() => console.log(univerAPI.getActiveWorkbook().getActiveSheet().getImages().length), 1500);
   // → 0. Without the dt.setData('text/html', …) line → 1.
   ```

### Expected behavior

The image file is pasted as a floating image, exactly as when the clipboard contains only the file: the HTML carries nothing else that could be pasted. The HTML should keep precedence when it has real content — text or a `<table>` — for example spreadsheet applications that also put a picture of the copied range on the clipboard.

### Actual behavior

On 1.0.1, pasting into C3 (Chromium 153 and WebKit 26.6 give the same results):

| Clipboard content | Result |
|---|---|
| image file only | 1 floating image |
| image file + `<img src="https://…">` | nothing pasted, no message |
| image file + `<meta charset='utf-8'><img src="https://…" alt="…"/>` | nothing pasted, no message |
| image file + `<img src="data:image/png;base64,…">` | 1 floating image |
| image file + `<table><tr><td>11</td><td>22</td></tr></table>` | C3:D3 = 11, 22; no image (as intended) |

The `paste` event is `defaultPrevented` in every case, so the browser does nothing either. On 1.0.0 the second row (image file + `<img src="https://…">`) also inserted nothing in Chromium, Chrome and WebKit.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag; the code is unchanged in the published 1.0.1 and 1.0.2 packages.

- `packages/sheets-ui/src/services/clipboard/utils.ts` L120–131: `htmlContainsImage()` only matches `<img src="data:image/…;base64,…">`.
- `packages/sheets-ui/src/services/clipboard/clipboard.service.ts`
  - `legacyPaste()` — keyboard paste, reached from `SheetPasteShortKeyCommand` (`packages/sheets-ui/src/commands/commands/clipboard.command.ts` L131–147): L473 `const shouldUseHTMLPaste = !files?.length || !htmlContainsImage(html ?? '')`. The HTML branch (L475–476) wins; the files branch (L477–478) is only reached when there is no HTML or the HTML has a base64 image.
  - `paste(item: ClipboardItem)` — paste from the menu through the async Clipboard API (`clipboard.command.ts` L108–118): the same rule at L416–418; `_pasteHTML()` at L433, so the image branch (L436–451) is skipped. (From the source; our tests only exercised the keyboard path.)
  - `_pasteHTML()` → `_pasteExternal()` (L789–814) → `HtmlToUSMService.convert()` (L804) does not convert `<img>`, so the paste ends with nothing.
- The keyboard path got this rule in #7712 ("fix(sheets-ui): improve external clipboard paste", merged 2026-09-20). Before, `legacyPaste()` pasted the files whenever files were present and the HTML did not come from Excel, so "Copy image" worked on that path; on the other hand a table copied from a non-Excel spreadsheet application together with a picture of it was pasted as the picture, which is presumably what #7712 addressed.
- `@univerjs/drawing-ui` already has the predicate this decision needs: `isImageOnlyClipboardHtml()` (`packages/drawing-ui/src/utils/clipboard-image.ts` L88–94 — the HTML has an `<img>` / `<svg>`, no other text and no `<table>`; added in #7611). The sheet paste does not use it (`@univerjs/sheets-ui` does not depend on `@univerjs/drawing-ui`).

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0; the code above is unchanged in 1.0.2 (latest on npm on 2026-09-28).
- Affected package: `@univerjs/sheets-ui` (`SheetClipboardService`).
- Browsers: Chromium 153.0.8010.12 (Playwright build), WebKit 26.6 (Playwright build), headless via Playwright 1.63.0; on 1.0.0 also Google Chrome 153.0.8010.53. The paste was dispatched as a synthetic `ClipboardEvent` on the focused hidden input (same path as Ctrl/Cmd+V); we did not record a real "Copy image" clipboard in this run.
- OS: macOS 27.0 for the 1.0.1 runs, macOS 26.5.1 for the 1.0.0 runs (Apple M4 Pro).

### Suggested fix

- In both `paste()` and `legacyPaste()`: when the clipboard has an image file and the HTML is image-only (the `isImageOnlyClipboardHtml()` rule: an `<img>` / `<svg>`, no text, no `<table>`), paste the file with `_pasteFiles()`; otherwise keep the current order. This keeps the #7712 behavior for spreadsheet applications (table HTML + picture) and fixes "Copy image".
- The predicate could move to a package both `sheets-ui` and `drawing-ui` can use (for example `@univerjs/ui` or `@univerjs/core`).
- Tests: image file + image-only HTML → floating image; image file + table HTML → cells; image file + base64 `<img>` → floating image.
