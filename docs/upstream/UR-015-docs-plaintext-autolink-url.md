# UR-015 纯文本粘贴时，自动识别出的链接地址是整段粘贴的文字

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P5 报告 §4.3"纯文本"行、§4.2"粘贴：纯文本里的网址（SDK 默认）"表、§6"上游报告"第 5 条；用例 `spikes/m0/e2e/v13-paste.spec.ts`（"V13 粘贴：纯文本里的网址（SDK 默认，对照）"，结果 `spikes/m0/e2e/results/v13/paste/*-plain-links-default.json`）；平台的规避见报告 §1.2 第 4 条与 `spikes/m0/src/harness/doc-policy.ts`（粘贴清洗把地址改用链接文字）；关联 DEF-006（真实来源的粘贴复核）｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：① GitHub 上 v1.0.0…v1.0.1 只改了 README 与版本号；② 已安装的 `@univerjs/core@1.0.1` 发布包 `lib/es/index.js` 的 `fromPlainText` 里，链接的 `properties.url` 仍取整个入参 `text` 而不是这一行 `paragraphText`；③ 2026-09-28 直接调用 1.0.1 的 `BuildTextUtils.transform.fromPlainText`，并在 1.0.1 的最小页面上合成粘贴多行纯文本，生成的链接地址都是整段文字，Chromium、Chrome、WebKit 一致）

## 摘要（中文）

把多行纯文本粘贴进文字文档时，其中"像网址的行"会被自动识别成超链接，但链接地址取的是**整段粘贴的文字**（含换行），而不是那一行网址本身。例如粘贴"第一行\n第二行\nhttps://example.com/plain"，最后一行显示成链接，地址却是 `第一行\n第二行\nhttps://example.com/plain`。这样的链接点不开、复制/导出出去是坏的，服务端如果按"地址必须是规范 URL"校验还会存不了。单行纯文本（整段就是一个网址）不受影响，地址正确。根因在 `fromPlainText`：判断用的是本行 `paragraphText`，写入 `url` 时却用了整个入参 `text`。影响面比看起来大——`fromPlainText` 也用于纯文本粘贴、"仅保留文本"、Facade 的 `insertText`（`RichTextBuilder.insertText`）。平台的规避：粘贴清洗里发现链接地址不是规范 URL 时，如果链接文字本身是合法地址就改用链接文字，否则去掉链接。

## 已有的上游讨论

没有找到报告这个具体缺陷的 issue（GitHub issue/PR 检索，关键词：`fromPlainText`、`paste url link`、`plain text link`、`paste link url`、`复制链接 粘贴`；2026-09-28）。相关但不是同一问题：[#6001](https://github.com/dream-num/univer/issues/6001)（希望粘贴的链接被识别为真链接，2025-10，标记 invalid）、[#6013](https://github.com/dream-num/univer/issues/6013)（粘贴的链接点不开，2025-10，need info）、[#1494](https://github.com/dream-num/univer/issues/1494)（复制链接粘贴到文档不显示 URL，2024）——都在讨论"链接能不能识别/点开"，没有指出地址取成了整段文字。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Docs: pasting multi-line plain text auto-links a URL line, but sets the link URL to the whole pasted text instead of that line

### Describe the bug

When multi-line plain text is pasted into a document, a line that looks like a URL is auto-detected as a hyperlink, but the hyperlink's `url` is the **entire pasted string** (including the other lines and the newlines), not the URL on that line. The link text is the URL, so it looks fine, but the stored `url` is unusable: it cannot be opened, it is broken when copied/exported, and a server that validates "the URL must be a well-formed URL" will reject the save. Single-line plain text (the whole string is one URL) is fine.

`BuildTextUtils.transform.fromPlainText()` is also used by the "keep text only" paste and by the Facade `FDocument.insertText` (via `RichTextBuilder.insertText`), so the same wrong URL appears there.

### To reproduce

Reproduction link: _to be added (StackBlitz)_. Two ways:

**A. Public API (Node or browser), no UI needed:**

```js
import { BuildTextUtils } from '@univerjs/core';
const body = BuildTextUtils.transform.fromPlainText('line one\nline two\nhttps://example.com/plain');
console.log(body.customRanges);
// [{ rangeType: 0, startIndex: 18, endIndex: 42,
//    properties: { url: 'line one\nline two\nhttps://example.com/plain' }, … }]
// The link text is 'https://example.com/plain' but properties.url is the whole string.
```

**B. Paste into a document.** With the caret in the document, dispatch a paste whose `text/plain` is `line one\nline two\nhttps://example.com/plain` (a keyboard paste of the same clipboard content behaves identically):

```js
const dt = new DataTransfer();
dt.setData('text/plain', 'line one\nline two\nhttps://example.com/plain');
document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
```

The third paragraph becomes a link with text `https://example.com/plain` and `url` equal to the whole pasted string.

### Expected behavior

The hyperlink URL should be the URL detected on that line (`https://example.com/plain`), the same as the link text — as it already is when the pasted text is a single line.

### Actual behavior

On 1.0.1 (Chromium 153.0.8010.12, Chrome 153.0.8010.53, WebKit 26.6): the auto-linked line's `url` is the entire pasted text (`line one\nline two\nhttps://example.com/plain`). Single-line input (`https://example.com/only`) gives the correct `url`.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag (unchanged in the published 1.0.1 / 1.0.2 `@univerjs/core`).

- `packages/core/src/docs/data-model/text-x/build-utils/parse.ts`, `fromPlainText()` L55–109:
  - L63–64: `loopParagraph(i)` computes `paragraphText = dataStream.slice(cursor, i)` for the current line and tests `Tools.isLegalUrl(paragraphText)` (L65).
  - L67–76: when the line is a URL it builds the custom range but sets `properties: { url: text }` (L74) — `text` is the **function argument** (the whole pasted string), not `paragraphText` / `urlText` for this line.

`url: text` should be `url: urlText` (which equals `paragraphText`).

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. v1.0.1 and v1.0.2 contain no change to `parse.ts`; `dev` has no later commit to it (checked 2026-09-28).
- Browsers: Chromium 153.0.8010.12 (Playwright build), Google Chrome 153.0.8010.53, WebKit 26.6 (Playwright build), headless via Playwright 1.63.0; case A also run directly in Node against `@univerjs/core@1.0.1`.
- OS: macOS 27.0 (Apple M4 Pro), 2026-09-28.

### Suggested fix

- In `fromPlainText()` L74, use the per-line URL: `properties: { url: urlText }` (i.e. `paragraphText`) instead of `properties: { url: text }`.
- Add a unit test with multi-line input where a non-first/last line is a URL.
