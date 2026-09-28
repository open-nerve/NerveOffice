# UR-017 单元格里粘贴含表格的内容静默失败

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P5 报告 §4.2"粘贴：其他目标"表、§4.3 转换偏差表最后一行、§6"上游报告"第 7 条；用例 `spikes/m0/e2e/v13-paste.spec.ts`（"V13 粘贴：word-win / web-article / google-docs / plain → cell"，结果 `spikes/m0/e2e/results/v13/paste/*-cell-platform.json`）与 `spikes/m0/e2e/v13-capabilities.spec.ts`（C5 的"单元格里粘贴含表格的内容"步骤，结果 `spikes/m0/e2e/results/v13/capabilities/*-C5-platform.json`）；没有专属的 DEF（关联 DEF-006 真实来源的粘贴复核）｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：已安装的 `@univerjs/docs-ui@1.0.1` 发布包 `lib/es/index.js` 里，`InnerPasteCommand` 仍有 `if (hasTable && (hasRangeInTable(selections) || rectRanges.some((range) => !range.spanEntireTable))) return false;`，粘贴控制器仍是 `legacyPaste(...).catch(() => void 0)`、不看结果；npm 上的 1.0.2（当前 latest）同样；GitHub dev 分支上这两个文件自 2026-09-22 起没有新提交）

## 摘要（中文）

光标在文字文档的表格单元格里时，粘贴任何含表格的 HTML（从 Word、Google Docs、网页复制的内容，或者只有一张表格的片段），SDK 整体放弃这次粘贴：不嵌套表格是 SDK 的既定限制，但连其中的文字也不粘贴；粘贴事件的默认行为已经被阻止，界面上没有任何提示，用户看到的就是"按了粘贴没反应"，容易以为剪贴板是空的。只含纯文本的剪贴板在单元格里可以正常粘贴。平台目前没有规避：P5 把它归入粘贴的转换偏差，对应 00 号计划书 §4.5 的已知限制"从其他应用粘贴到文字文档时，部分格式可能丢失或改变"，由 M6 决定是在平台的粘贴清洗里把表格拆成文字，还是等上游修复。证据状况：M0 的记录是在平台配置下取得的（Chromium、Chrome、WebKit 三个浏览器一致），平台的粘贴钩子不改动表格，这几次粘贴也没有留下任何平台处理记录，放弃发生在 SDK 的 `InnerPasteCommand` 里；提交前用 SDK 默认配置重跑一次、补 StackBlitz 复现链接与 `npx envinfo` 输出（待补充），重跑之后可以删掉正文 Environment 里关于钩子的那句说明。

## 已有的上游讨论

没有找到直接相关的 issue 或 PR（GitHub issue 检索，关键词：`paste table cell`、`paste into table cell`、`paste table in table`、`nested table`、`nested table paste`、`docs paste table into table`、`paste table docs`、`paste html table doc cell`、`docs paste silently`、`paste nothing happens docs`、`InnerPasteCommand`、`"paste tables into table cell"`、`hasRangeInTable`、`文档 表格 粘贴`、`单元格 粘贴 表格`；另用 WebSearch 检索网页；2026-09-28）。相关但不是同一个问题：[#3214](https://github.com/dream-num/univer/pull/3214)（fix(docs): paste table after table，2024 年，已关闭）；[#7709](https://github.com/dream-num/univer/pull/7709)（feat(docs-ui): add paste special and post-paste formatting，2026-09-20 合并，已包含在 1.0.0 中，没有改变这里的行为）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Docs: pasting content that contains a table into a table cell silently does nothing (the text is dropped too)

### Describe the bug

In a Univer document, when the caret is inside a table cell and the clipboard HTML contains a `<table>` (for example content copied from Word, Google Docs or a web page), the whole paste is rejected. Nested tables are not supported, which is understandable, but nothing at all is inserted — not even the text of the copied content — and the user gets no feedback. The `paste` event's default action has already been prevented, so for the user the paste simply "does nothing". Pasting plain text into the same cell works.

### To reproduce

Reproduction link: 【待补充：提交前把下面的片段放进官方 StackBlitz 模板（改用 Docs 预设），生成复现链接】

The steps below only use public APIs and the default UI.

1. Set up a document editor with the Docs core preset (1.0.1):

   ```ts
   import { createUniver, getDocsEmptySnapshot, LocaleType, mergeLocales } from '@univerjs/presets';
   import { UniverDocsCorePreset } from '@univerjs/preset-docs-core';
   import DocsCoreEnUS from '@univerjs/preset-docs-core/locales/en-US';
   import '@univerjs/preset-docs-core/lib/index.css';

   const { univerAPI } = createUniver({
       locale: LocaleType.EN_US,
       locales: { [LocaleType.EN_US]: mergeLocales(DocsCoreEnUS) },
       presets: [UniverDocsCorePreset({ container: 'app' })],
   });
   univerAPI.createDocument(getDocsEmptySnapshot());
   ```

2. Click into the document and insert a table: **Insert → Table → Insert Table**, 2 rows × 2 columns.
3. Click into the first cell.
4. Copy any HTML table (a table on a web page, in Word or in Google Docs) and press Ctrl/Cmd+V. For a deterministic check, run this in the DevTools console instead (after step 3 the editor's hidden input element is `document.activeElement`; this is the same path as a keyboard paste):

   ```js
   const dt = new DataTransfer();
   dt.setData('text/html', '<table><tr><td>inner</td><td>table</td></tr></table>');
   dt.setData('text/plain', 'inner\ttable');
   const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
   document.activeElement.dispatchEvent(event);
   console.log('defaultPrevented:', event.defaultPrevented);
   ```

5. Nothing is inserted, no message is shown, and `defaultPrevented` is `true`. With a plain-text-only clipboard (no `text/html`) the text is inserted into the cell as expected.

### Expected behavior

The table structure cannot be kept (nested tables are not supported), but the paste should not be lost silently. Either:

- paste the content without the table structure — for example each table row as a paragraph, cell texts separated by a tab — similar to the plain-text fallback that `DocClipboardController` already applies to embedded editors when the HTML contains `</table>`; or
- tell the user why nothing was pasted (e.g. "Tables can't be pasted into a table cell"), ideally pointing to "Keep text only".

### Actual behavior

With clipboard samples shaped like Word (Windows), Google Docs and a web article pasted into a cell of a 2 × 2 table, and with a minimal `<table>` fragment pasted into a cell of a 4 × 3 table:

- the document is unchanged (no text, no table) in all three browsers listed below;
- no error in the console and no notification;
- the `paste` event is `defaultPrevented` (recorded for the three samples).

Plain-text clipboard content pasted into the same cell is inserted normally. Judging from the source, the same early `return false` also applies to tables pasted into a header/footer; we did not test that (we only use the modern layout).

### Root cause analysis

Line numbers refer to the `v1.0.0` tag.

- `packages/docs-ui/src/commands/commands/clipboard.inner.command.ts`
  - L166–170: `// TODO: @JOCS A feature that has not yet been implemented. // Can not paste tables into table cell now.` followed by `if (hasTable && (hasRangeInTable(selections) || rectRanges.some((range) => !range.spanEntireTable))) { return false; }`. The whole paste is rejected, not only its table part.
  - L160–164: the same early `return false` when the pasted body has tables and the target is a header/footer segment.
- `packages/docs-ui/src/services/clipboard/clipboard.service.ts`: `_pasteWithOptions()` (L526–564) → `_paste()` (L722–828) → `syncExecuteCommand(InnerPasteCommand.id, …)` (L814). The `false` result is only returned; no message is raised and no paste-options session is created.
- `packages/docs-ui/src/controllers/render-controllers/doc-clipboard.controller.ts` L57–89: the `paste` event is `preventDefault()`-ed first (L62) and the promise returned by `legacyPaste(...)` is discarded with `.catch(() => undefined)` (L82–88). L73–80 already contain a fallback for embedded editors — when the HTML contains `</table>` it is dropped so that the plain text gets pasted — but it does not apply when the caret is in a table cell of the main document body.

The same code is present in the published 1.0.1 and 1.0.2 packages (`@univerjs/docs-ui/lib/es/index.js`).

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. The runtime observations were made on 1.0.0; the code quoted above is unchanged in the published 1.0.1 and 1.0.2 packages.
- Browsers: Chromium 153.0.8010.12 (Playwright build), Google Chrome 153.0.8010.53, WebKit 26.6 (Playwright build) — all headless via Playwright 1.63.0; the paste was dispatched as a synthetic `ClipboardEvent` on the focused hidden input (same code path as Ctrl/Cmd+V). Our app had an `onBeforePaste` clipboard hook installed that normalizes link URLs and removes images / stray section breaks; it does not touch tables and made no changes in these runs.
- OS: macOS 26.5.1 (Apple M4 Pro)

### Suggested fix

- In `InnerPasteCommand` (or in `_paste()` before calling it): when the target is inside a table cell (or a header/footer) and the pasted body contains tables, flatten those tables into paragraphs — e.g. one paragraph per row, cell texts joined with `\t` — and paste the rest as usual instead of returning `false`.
- If rejecting is kept, surface it to the user (e.g. through `IMessageService`) instead of failing silently.
