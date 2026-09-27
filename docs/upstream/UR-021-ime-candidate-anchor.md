# UR-021 输入法候选框的锚点偏离组合文字

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P5 报告 §3.2"候选框锚点"表、§3.3 第 3 条、§6"上游报告"第 11 条；审查报告 G10；00 号计划书 §4.3；用例 `spikes/m0/e2e/v13-ime.spec.ts`（"V13 候选框锚点"，SDK 默认配置，结果 `spikes/m0/e2e/results/v13/ime/*-candidate-anchor.json`）；DEF-013（macOS 真实输入法的人工核对，待办）、DEF-005（Windows 输入法）｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：已安装的 `@univerjs/docs-ui@1.0.1` 发布包里，隐藏输入元素的样式没有变——父元素 `position:absolute; height:1px; width:1px; overflow: hidden`，输入元素 `white-space: pre-wrap`，不设字号与宽度；`_updateInputPosition()` 仍把容器放到当前选区的锚点，组合进行中就是画布上组合文字的末尾；1.0.2 同样；GitHub dev 分支上 `doc-selection-render.service.ts` 自 2026-09-22 起没有新提交）

## 摘要（中文）

系统输入法的候选框贴着 SDK 隐藏输入元素（`div#__editor_<unitId>`）里的光标。组合进行中，SDK 每次更新都把组合文字写进正文、把光标放到组合文字末尾，再把隐藏输入元素移到这个位置；浏览器又把组合文字写进隐藏输入元素本身，用的是宿主页面继承的字体（验证页面上是 16px，不随文档字号与缩放变化），而它的父元素只有 1px 宽、输入元素是 `pre-wrap`，组合文字一长就逐词换行。M0 的测量（合成的组合事件，三个浏览器结果一致）：隐藏输入元素里组合文字的末尾比画布上的光标偏右 13–27 px，并随换行向下偏 18–54 px；改成不换行后纵向偏移为 0，横向偏移却变成 13、44、89 px，约等于组合文字在隐藏输入元素里的全宽，两种方式都对不齐。影响：候选框可能离正在输入的文字较远，句子越长越明显；如果真实输入法下同样偏离，中文用户每次输入长句都会碰到。平台目前没有规避：M6 计划缓解（隐藏输入元素定位到组合开始处、字号按缩放与画布一致、不换行）；真实候选框的位置要等 macOS 人工核对（DEF-013，M6 开始前）与 Windows 核对（DEF-005），再决定是否写进 00 号计划书 §4.5 的已知限制。上游 #7147 修过"候选框不在光标附近"（#7256，改的是隐藏编辑器定位时的包含块换算，1.0.0 已包含），本条是在那之后仍然存在的偏移。证据状况：只有合成事件下的 DOM 测量，还没有真实输入法下候选框的截图——提交前最好先做 DEF-013 的人工核对并补截图，同时补 StackBlitz 复现链接与 `npx envinfo` 输出（待补充）。

## 已有的上游讨论

相关、但原因不同：[#7147](https://github.com/dream-num/univer/issues/7147)（[Bug] The input method display box is not near the cursor，2026-06-24 提出，2026-07-14 关闭），由 [#7256](https://github.com/dream-num/univer/pull/7256)（fix(docs-ui): align IME input with cursor，2026-07-14 合并）修复——那次把隐藏编辑器的坐标换算改为以 `offsetParent` 为包含块；我们的测量在 1.0.0 上进行，已经包含这个修复。表格侧的同类问题：[#6050](https://github.com/dream-num/univer/issues/6050)（单击激活单元格后输入，拼音候选框的位置不对，open）、[#7749](https://github.com/dream-num/univer/pull/7749)（fix(sheets-ui): keep IME input on the selected cell before editing，open PR）。没有找到针对文字文档"组合进行中隐藏输入元素放在组合文字末尾、字号固定、会换行"的 issue 或 PR（GitHub issue 检索，关键词：`IME candidate`、`IME candidate window position`、`IME position`、`IME offset`、`IME docs`、`IME zoom`、`IME hidden input`、`composition position`、`composition hidden`、`candidate window`、`pinyin position`、`input method`、`输入法 候选`、`输入法 位置`、`候选框`；另用 WebSearch 检索网页；2026-09-28）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Docs: IME candidate window drifts away from the composition — the hidden input is moved to the composition end, uses the host page's font and wraps inside a 1px-wide parent

### Describe the bug

In Univer Docs the composition goes into the hidden contenteditable `div#__editor_<unitId>`, and the browser positions the operating system's IME candidate window from the caret / composition range inside that element. During a composition:

- after every `compositionupdate` the SDK writes the composition into the document, puts the caret at its end and moves the hidden input's container to that caret, i.e. to the **end** of the composition as drawn on the canvas;
- the browser also puts the composition text into the hidden input itself, rendered with the font inherited from the host page (16px in our page), independent of the document's font size and zoom;
- the hidden input's parent is `1px × 1px` with `overflow: hidden` and the input has `white-space: pre-wrap`, so the composition wraps at every break opportunity.

As a result the DOM caret is to the right of the canvas caret by about the DOM width of the composition and moves one line down per wrap, so the candidate window drifts away from the text being composed. This is different from #7147 (fixed by #7256, the containing-block conversion of the hidden editor); our measurements were taken on 1.0.0, which already includes that fix.

### To reproduce

Reproduction link: 【待补充：提交前把 Docs 预设放进官方 StackBlitz 模板，生成复现链接】

Screenshots with a real IME: 【待补充：DEF-013 人工核对时的截图——macOS 简体拼音，Safari 与 Chrome，100% 与 150% 缩放】

**A. With a system IME:** in any Univer document (e.g. the Docs core preset with `univerAPI.createDocument(getDocsEmptySnapshot())`), type a long Pinyin composition such as `nihaoshijie` at 100% and at 150% zoom, and compare the candidate window with the composition drawn on the canvas.

**B. Deterministic measurement (what we ran):** synthetic composition events, with the composition text written into the hidden input the way the browser does it. Click into a paragraph so that the hidden input has focus, then run in the console:

```js
const input = document.activeElement;                // div#__editor_<unitId>
const container = input.parentElement.parentElement; // #univer-doc-selection-container-<unitId>
const startX = container.getBoundingClientRect().left;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

input.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
for (const text of ['ni', 'ni hao', 'ni hao shi jie']) {
    input.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }));
    input.textContent = text; // what the browser does with the composition
    const caret = document.createRange();
    caret.selectNodeContents(input);
    caret.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(caret);
    await sleep(300);

    const box = container.getBoundingClientRect(); // placed at the canvas caret
    const content = document.createRange();
    content.selectNodeContents(input);
    const rects = content.getClientRects();
    const last = rects[rects.length - 1];
    console.log(text, {
        containerShift: Math.round(box.left - startX), // width of the composition on the canvas
        dx: Math.round(last.right - box.left),         // DOM caret vs. canvas caret
        dy: Math.round(last.top - box.top),
        font: getComputedStyle(input).font,
    });
}
input.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true })); // cancels the composition
```

Our results (px):

| Zoom | Hidden input | Composition | Container shift (≈ composition width on canvas) | dx | dy |
|---|---|---|---|---|---|
| 100% | as shipped | `ni` | 11 | 13 | 0 |
| 100% | as shipped | `ni hao` | 40 | 27 | 18 |
| 100% | as shipped | `ni hao shi jie` | 81 | 16 | 54 |
| 150% | as shipped | `ni` | 17 | 13 | 0 |
| 150% | as shipped | `ni hao` | 60 | 27 | 18 |
| 150% | as shipped | `ni hao shi jie` | 122 | 16 | 54 |
| 100% | `white-space: pre` (experiment) | `ni` | 11 | 13 | 0 |
| 100% | `white-space: pre` (experiment) | `ni hao` | 40 | 44 | 0 |
| 100% | `white-space: pre` (experiment) | `ni hao shi jie` | 81 | 89 | 0 |

Chromium, Chrome and WebKit gave the same values, except that WebKit's container shift for `ni hao shi jie` at 100% is 82. The hidden input's computed font (first 40 characters recorded) was `16px -apple-system, "system-ui", "PingFang SC…` (Chromium, Chrome) and `16px -apple-system, BlinkMacSystemFont, PingF…` (WebKit), at both zoom levels.

### Expected behavior

The IME candidate window stays attached to the text being composed on the canvas (for example just below the composition, near its start or near the caret), whatever the composition length, the zoom level and the host page's font.

### Actual behavior

- The DOM caret inside the hidden input is 13–27 px to the right of the canvas caret and moves 18–54 px down as the composition wraps (table above).
- The hidden input keeps the host page's 16px font at 150% zoom, so the DOM composition and the canvas composition have different widths.
- Preventing wrapping (`white-space: pre`) removes the vertical drift, but the horizontal offset grows to roughly the full DOM width of the composition (13 / 44 / 89 px), because the hidden input starts where the canvas composition ends.
- We have not yet recorded the on-screen candidate window with a real system IME; screenshots will be attached.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag.

- `packages/docs-ui/src/services/selection/doc-selection-render.service.ts`
  - `_initDOM()` (L969–994): `container > inputParent > input`.
  - `_initInput()` (L1003–1028): `inputParent` is `position:absolute; height:1px; width:1px; overflow:hidden`; the input is `position:absolute; white-space:pre-wrap; color:transparent; caret-color:transparent` without font size, line height or width, so it inherits the host page's font and its available width is 1px.
  - `_updateInputPosition()` (L1282–1311, called at the end of `addDocRanges()`, L533) moves the container to the anchor of the active range through `activate()` / `_positionInput()` (L587–603).
- `packages/docs-ui/src/controllers/render-controllers/doc-ime-input.controller.ts` (L96–177) and `packages/docs-ui/src/commands/commands/ime-input.command.ts` (L128–138): every `compositionupdate` writes the composition into the model and sets the caret to `replacementOffset + newText.length`, i.e. the end of the composition — which is where the container is then moved.

The same code is present in the published 1.0.1 and 1.0.2 packages (`@univerjs/docs-ui`).

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. The measurements were taken on 1.0.0 (which already includes #7256); the code quoted above is unchanged in the published 1.0.1 and 1.0.2 packages.
- Browsers: Chromium 153.0.8010.12 (Playwright build), Google Chrome 153.0.8010.53, WebKit 26.6 (Playwright build) — headless via Playwright 1.63.0, with synthetic composition events (no system IME involved).
- OS: macOS 26.5.1 (Apple M4 Pro)

### Suggested fix

- While composing, keep the hidden input anchored at the composition **start** (the caret position at `compositionstart`) instead of moving it to the caret after every update.
- Give the hidden input the font size and line height of the text at the caret, multiplied by the zoom ratio, so that the DOM composition is about as wide as the canvas composition.
- Do not wrap while composing: `white-space: pre` and no 1px width constraint (e.g. `width: max-content` on the parent; the text is already invisible through `color: transparent`).
- Alternatively, align the end of the DOM composition with the canvas caret.
