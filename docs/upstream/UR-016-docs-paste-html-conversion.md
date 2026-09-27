# UR-016 HTML 粘贴到文字文档时的多处转换偏差

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P5 报告 §4.3（转换偏差表）、§4.1、§6"上游报告"第 6 条；用例 `spikes/m0/e2e/v13-paste.spec.ts` 与剪贴板样本 `spikes/m0/fixtures/paste/`（`README.md` 说明这些样本按各来源的真实结构编写、不是真实截取，真实来源复核登记为 DEF-006）；平台的处理方向见报告 §6"M6"｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：① GitHub 上 v1.0.0…v1.0.1 只改了 README 与版本号；② 已安装的 `@univerjs/docs-ui@1.0.1` 发布包 `lib/es/index.js` 里，`extractNodeStyle` 仍把 `b`/`em`/`strong` 都映射为粗体、只处理 `s` 不处理 `del`、`case "text-decoration"` 仍按短横线写法匹配，`getHeadingNamedStyleType` 仍只认 H1–H5，`_process` 仍没有 `BR` 分支；③ 2026-09-28 用最小的手写 HTML 在 1.0.1 的最小页面上合成粘贴，逐项复现，Chromium 与 WebKit 一致，结果见下表）

## 摘要（中文）

从 HTML 粘贴到文字文档时，有一批转换偏差。本报告只列用**最小、只依赖公开 API 的手写 HTML**在 1.0.1 上稳定复现、且能定位到源码的几项：`<br>` 丢失（两行并成一行）；`<em>` 被当成粗体（应为斜体）；Google Docs 外层 `<b style="font-weight:normal">` 把全文变粗；`<h6>` 变正文（只认 H1–H5）；`<del>` 的删除线丢失（只处理 `<s>`）；CSS `text-decoration: underline`（写在 `style` 上、非 `<u>` 标签）丢失；嵌套列表里父项的文字并进第一个子项。证据说明：M0 的剪贴板样本是按各来源真实结构编写、不是真实截取（DEF-006），这里改用最小手写 HTML 复现，避免被样本细节干扰；每项都给了最小复现与源码位置。另有几项与具体 Office HTML 强相关（Word 的 `MsoTitle`、WPS 的 `p.MsoHeading1` 标题类不识别；Word/WPS 的列表标记——Wingdings 项目符号字符、中文编号——残留在文字里），它们依赖真实来源的确切结构，等 DEF-006 用真实剪贴板复核后再单独提，正文末尾只作说明、不作为本报告的结论。平台的规避方向（M6）：在粘贴前规范 HTML（补 `<br>`、按 `font-weight` 判断粗体、`<em>`/`<del>` 语义、CSS `text-decoration-*`、标题类），或推动上游修复。

## 已有的上游讨论

没有找到覆盖文字文档这些转换的 issue（GitHub issue/PR 检索，关键词：`paste br`、`paste em italic`、`paste heading`、`paste underline`、`paste line break`、`粘贴 文档`；2026-09-28）。相关但不同：[#4670](https://github.com/dream-num/univer/pull/4670)（fix: paste rich text with br should keep line break，2025-02 合并）只改了 **sheets-ui** 的转换器（`packages/sheets-ui/.../html-to-usm/converter.ts` 有 `br` 分支），docs-ui 的 `html-to-udm/converter.ts` 没有对应处理；[#5438](https://github.com/dream-num/univer/issues/5438)（粘贴不识别换行）是表格场景。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Docs: several HTML→document paste conversions are wrong (`<br>`, `<em>`, Google Docs `<b>` wrapper, `<h6>`, `<del>`, CSS `text-decoration`, nested lists)

### Describe the bug

Pasting HTML into a document (`@univerjs/docs-ui`'s `html-to-udm` converter) mishandles several common cases. The list below is limited to deviations we could reproduce on 1.0.1 with **minimal, hand-written HTML using only public APIs**, each with an identifiable cause in the converter:

1. **`<br>` is dropped.** `<p>line one<br>line two</p>` becomes a single paragraph `line oneline two` (the two lines run together). The Sheets converter handles `<br>` (since #4670); the Docs converter does not.
2. **`<em>` becomes bold instead of italic.** Text in `<em>` is stored with `bl` (bold), not `it` (italic).
3. **A Google-Docs-style `<b style="font-weight:normal">` wrapper makes everything bold.** Google Docs wraps copied content in `<b id="docs-internal-guid-…" style="font-weight:normal">`; the whole pasted content becomes bold.
4. **`<h6>` becomes normal text.** `<h1>`–`<h5>` map to headings; `<h6>` loses its heading style.
5. **`<del>` loses its strikethrough.** `<s>` is handled, `<del>` is not.
6. **CSS `text-decoration: underline` (via `style`, not a `<u>` tag) is dropped.** A `<span style="text-decoration: underline">` is stored without underline; `<u>` still works.
7. **Nested list: the parent item's text merges into the first child.** `<ul><li>Parent<ul><li>Child</li></ul></li><li>Sibling</li></ul>` produces one list item `ParentChild` (at the child's nesting level) plus `Sibling`, instead of `Parent` / `Child` / `Sibling`.

### To reproduce

Reproduction link: _to be added (StackBlitz)_. With the caret in a document, dispatch a paste with the given `text/html` (a keyboard paste of the same clipboard content behaves identically). Minimal Docs setup: `UniverDocsPlugin` + `UniverRenderEnginePlugin` + `UniverUIPlugin` + `UniverDocsUIPlugin` (1.0.1), no other plugins.

```js
function paste(html, text) {
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', text);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}
```

| # | `text/html` | Expected | Actual (1.0.1) |
|---|---|---|---|
| 1 | `<p>line one<br>line two</p>` | two lines | one paragraph `line oneline two` |
| 2 | `<p>plain <em>emphasis</em> end</p>` | `emphasis` italic | `emphasis` bold (`bl:1`), not italic |
| 3 | `<b style="font-weight:normal;" id="docs-internal-guid-1"><span style="font-weight:400;">normal </span><span style="font-weight:700;">bold</span></b>` | `normal` not bold, `bold` bold | whole run `normal bold` is bold |
| 4 | `<h5>five</h5><h6>six</h6>` | both headings | `five` heading (namedStyleType 8), `six` normal text |
| 5 | `<p><del>deleted</del> and <s>struck</s></p>` | both strikethrough | only `struck` has strikethrough; `deleted` has none |
| 6 | `<p><span style="text-decoration: underline">u1</span> and <u>u2</u></p>` | both underlined | only `u2` underlined; `u1` has none |
| 7 | `<ul><li>Parent<ul><li>Child</li></ul></li><li>Sibling</li></ul>` | `Parent`, `Child`, `Sibling` | `ParentChild` (one item), `Sibling` |

Same results in Chromium 153 and WebKit 26.6.

### Expected behavior

See the table. In short: keep `<br>` as a line break; map `<em>` to italic and `<del>` to strikethrough; do not treat a `<b style="font-weight:normal">` wrapper as bold; support `<h6>`; read the `text-decoration` shorthand; keep the parent list item's text on its own line.

### Actual behavior

As in the table; no console errors.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag (unchanged in the published 1.0.1 / 1.0.2 `@univerjs/docs-ui/lib/es/index.js`).

- **1. `<br>`** — `packages/docs-ui/src/services/clipboard/html-to-udm/converter.ts`, `_process()` L152–256 has branches for text nodes, `IMG`, tables, code blocks, lists, links and default block elements, but none for `BR`. (`packages/sheets-ui/.../html-to-usm/converter.ts` L617–626 does add a paragraph for `br`.)
- **2. `<em>` / 3. `<b>` wrapper** — `packages/docs-ui/src/services/clipboard/html-to-udm/parse-node-style.ts`, `extractNodeStyle()` L27–33: `case 'b': case 'em': case 'strong':` all set `docStyles.bl = TRUE`. `<em>` should set `it`. And for a `<b>` (or `<strong>`) tag, the tag-based bold overrides the inline `font-weight`, so `<b style="font-weight:normal">` is treated as bold; `font-weight` is only read at L95–100 and does not undo the tag rule.
- **4. `<h6>`** — same file's caller uses `getHeadingNamedStyleType()` (converter.ts L1015–1024): only `H1`–`H5` map to a `NamedStyleType`; `H6` returns `null`. (`NamedStyleType` has no `HEADING_6`.) `isDefaultParagraphElement` (L1010–1013) still lists `H6`, so it becomes a normal paragraph.
- **5. `<del>`** — `extractNodeStyle()` L35–39 handles `case 's'` (strikethrough) but has no `del` case, so `<del>` contributes no style.
- **6. CSS `text-decoration`** — `extractNodeStyle()` L105–122 switches on `cssRule === 'text-decoration'`, but the CSSOM expands the `text-decoration` shorthand: iterating `element.style` yields `text-decoration-line` / `-thickness` / `-style` / `-color`, not `text-decoration`, so the case never matches. (Verified: for `style="text-decoration:underline"`, `[...el.style]` is `['text-decoration-line','text-decoration-thickness','text-decoration-style','text-decoration-color']`.) The Sheets converter reads `text-decoration-line` explicitly.
- **7. Nested list parent merge** — in `_process()` the parent `<li>`'s text node is appended before the child `<ul>` is processed, and a paragraph is only pushed on `</li>` / `_processAfterDefaultBlock` (L332–344, `_appendParagraph` L346–380); the inner list's items reuse the same open paragraph, so the parent text and the first child text end up in one paragraph at the child's nesting level. (This is our reading of the code; it matches the output.)

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. v1.0.1 and v1.0.2 contain no source changes in these files; `dev` shows no later commits to `converter.ts` / `parse-node-style.ts` in this area (checked 2026-09-28).
- Browsers: Chromium 153.0.8010.12 (Playwright build) and WebKit 26.6 (Playwright build), headless via Playwright 1.63.0; synthetic paste of the hand-written HTML above.
- OS: macOS 27.0 (Apple M4 Pro), 2026-09-28.

### Suggested fix

- Add a `BR` branch to the Docs `_process()` that starts a new paragraph (as Sheets already does), or a soft line break if the model supports one.
- In `extractNodeStyle()`: map `em` to italic (`it`), add a `del` case for strikethrough, and for `b`/`strong` respect an inline `font-weight:normal`/`< 700`; read `text-decoration-line` (and the shorthand) for underline/line-through/overline.
- Add `HEADING_6` or map `<h6>` to the nearest supported heading.
- Fix nested-list handling so the parent item's text stays on its own paragraph at its own level.

---

## 待补充（依赖真实来源，DEF-006）

以下几项在 M0 的手写样本里出现过，但与具体的 Office/网页 HTML 结构强相关，用最小 HTML 复现不稳定，等用真实应用、真实剪贴板复核（DEF-006）后再决定是否单独提上游，本报告不下结论：

- Word 的 `MsoTitle`、WPS 的 `p.MsoHeading1` 等"标题"段落样式类不被识别（当前只按 H1–H5 标签与段内 CSS 判断标题，不看 `class`）。
- Word/WPS 列表的标记残留在文字里：Wingdings 项目符号字符、中文编号（`一、`、`（一）`）等；`stripListMarkerFromCurrentParagraph`、`extractWordListInfo` 的启发式对不同来源的确切写法敏感。
- Google Docs 的下划线在整体 `<b>` 包裹场景下是否丢失，需用真实 Google Docs 剪贴板确认。
