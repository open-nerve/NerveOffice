# UR-012 按 WebKit 的提交顺序结束输入法组合后，撤销多删字、重做插回拼音

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P5 报告 §3.3 第 1 条、§3.2（中文输入表与"WebKit 顺序、SDK 默认：撤销与重做（示例）"）、§1.2 第 2 条、§6"上游报告"第 2 条；用例 `spikes/m0/e2e/v13-ime.spec.ts`（"V13 输入法：webkit 驱动，default"）与合成驱动 `spikes/m0/e2e/p5-helpers.ts` 的 `imeCompose`，结果 `spikes/m0/e2e/results/v13/ime/*-webkit-default.json`；审查报告 S2（WebKit 提交顺序的源码依据）；DEF-013（真实 Safari 与系统输入法的人工核对，M6 开始前，尚未进行）、DEF-005（Windows 输入法）｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：① GitHub 上 v1.0.0…v1.0.1 只改了 README 与版本号；② 已安装的 `@univerjs/docs-ui@1.0.1` 发布包里，`IMEInputCommand` 仍在 `syncExecuteCommand` 之后才 `pushUndoRedoMutationParams`，控制器在 `compositionend` 数据与上一次更新不同时仍以 `isCompositionEnd: true` 执行命令；`@univerjs/docs@1.0.1` 的 mutation 仍同步发出状态变更、拦截器同步取缓存；③ 2026-09-28 用正文里的控制台脚本在 1.0.1 的最小页面上复跑，Chromium、Chrome、WebKit 都复现，Chrome 顺序的对照正确）

## 摘要（中文）

输入法组合按 WebKit 的顺序提交（先删除组合文字、插入确认的文字，再派发 `compositionend`，中间没有携带最终文字的 `compositionupdate`）时，正文本身正确，但这一步的撤销记录是错的：撤销按最后一次组合文字（拼音）的长度删除，会多删掉后面的字，在表格单元格里还会删掉单元格边界的结构符、把两个单元格并成一个；重做插回的是拼音而不是汉字。Chrome 的顺序（最后一次 `compositionupdate` 就携带确认的文字）没有这个问题。这是 SDK 的逻辑缺陷，与浏览器本身无关：同样的合成事件在 Chromium、Chrome、WebKit 上结果一致。WebKit 的提交顺序依据 WebKit 源码（`Editor::setComposition` 的确认分支）与 WebKit 自己的布局测试期望输出；真实 Safari 加 macOS 系统输入法的事件记录还没有核对（DEF-013），正文里写明待补充。影响：Safari 用户用中文、日文等输入法输入后撤销，会误删正文、重做出拼音；协同时错误的撤销也会同步给别人。平台的规避：在捕获阶段拦下"数据与最后一次 `compositionupdate` 不同"的 `compositionend`，先补发一次携带最终文字的 `compositionupdate`，等一个宏任务再派发 `compositionend`（这期间来了键盘、输入、失焦等事件就先同步派发），13 种输入情形全部正确。

## 已有的上游讨论

没有找到（GitHub issue/PR 检索，关键词：`IME undo`、`IME docs`、`Safari IME`、`compositionend`、`composition undo`、`pinyin`、`输入法`、`输入法 撤销`；2026-09-28）。背景：[#1289](https://github.com/dream-num/univer/pull/1289)（2024-01 合并，refactor: ime use compose method to build undo and redo params）引入了现在"缓存每一步、组合成一条撤销记录"的做法；[#7256](https://github.com/dream-num/univer/pull/7256)、[#7147](https://github.com/dream-num/univer/issues/7147) 讨论的是输入法候选框的位置，与本问题无关。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Docs: after an IME composition committed in WebKit order (no final compositionupdate), undo deletes extra characters and redo re-inserts the raw composition text

### Describe the bug

When an IME composition ends with a `compositionend` whose `data` differs from the last `compositionupdate` — the WebKit/Safari commit sequence: `deleteCompositionText` and `insertFromComposition` input events, then `compositionend`, with no `compositionupdate` carrying the committed text — the document text is correct, but the history entry for the composition is wrong:

- **Undo** deletes as many characters as the *last composition string* had (6 for `ni hao`), starting at the insertion point: the committed text plus the characters that follow it. Inside a table cell it deletes cell-boundary tokens and merges two cells.
- **Redo** re-inserts the composition string (`ni hao`) instead of the committed text (`你好`).

With the Chromium sequence (a final `compositionupdate` whose data equals the committed text) undo and redo are correct.

### To reproduce

Reproduction link: _to be added (StackBlitz)_.

The real-world case is desktop Safari with a macOS IME (e.g. Pinyin: type `nihao`, pick `你好`, press Cmd+Z). We have not recorded that with a real system IME yet and will attach an event log once we have it (_pending_). The steps below reproduce the same event sequence deterministically with synthetic events, in any browser.

<details><summary>Minimal setup we used (public 1.0.1 packages only)</summary>

```ts
import { LocaleType, mergeLocales, Univer, UniverInstanceType } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverUIPlugin } from '@univerjs/ui';
import DesignEnUS from '@univerjs/design/locale/en-US';
import DocsUIEnUS from '@univerjs/docs-ui/locale/en-US';
import UIEnUS from '@univerjs/ui/locale/en-US';
import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/ui/facade';
import '@univerjs/docs/facade';
import '@univerjs/docs-ui/facade';

const univer = new Univer({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(DesignEnUS, UIEnUS, DocsUIEnUS) },
});
univer.registerPlugin(UniverDocsPlugin);
univer.registerPlugin(UniverRenderEnginePlugin);
univer.registerPlugin(UniverUIPlugin, { container: 'app' });
univer.registerPlugin(UniverDocsUIPlugin);

const text = 'First paragraph with some text.\rSecond paragraph for undo tests.\rThird paragraph.\r\r\n';
const paragraphs = [...text].flatMap((c, i) => (c === '\r' ? [{ startIndex: i }] : []));
univer.createUnit(UniverInstanceType.UNIVER_DOC, {
    id: 'doc',
    body: { dataStream: text, paragraphs, sectionBreaks: [{ startIndex: text.length - 1 }], textRuns: [] },
    documentStyle: { pageSize: { width: 794, height: 1124 }, marginTop: 50, marginBottom: 50, marginLeft: 50, marginRight: 50 },
});
window.univerAPI = FUniver.newAPI(univer);
```

</details>

1. Click anywhere into the document body, then put the caret right after `Second ` and focus the editor's hidden input:

   ```js
   const doc = univerAPI.getActiveDocument();
   const at = doc.getBody().dataStream.indexOf('Second ') + 'Second '.length;
   doc.setSelection(at, at);
   document.getElementById(`__editor_${doc.getId()}`).focus();
   ```

2. Run the following in the DevTools console. It types `ni hao` as a composition and commits `你好` in WebKit order; pass `'chrome'` instead of `'webkit'` for the control run.

   ```js
   (async (ORDER) => {
       const el = document.activeElement; // Univer's hidden input: div#__editor_<unitId>
       if (!el || !el.id.startsWith('__editor_')) throw new Error('Click into the document body first');
       // A native dispatch runs microtasks after each listener; a scripted dispatchEvent does not, so drain them.
       const drain = async () => { for (let i = 0; i < 20; i++) await null; };
       const fire = async (e) => { el.dispatchEvent(e); await drain(); };
       const key229 = (isComposing) => {
           const e = new KeyboardEvent('keydown', { key: 'Process', isComposing, bubbles: true, cancelable: true });
           Object.defineProperty(e, 'keyCode', { get: () => 229 });
           el.dispatchEvent(e);
       };
       key229(false);
       await fire(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
       for (const [i, text] of ['n', 'ni', 'ni h', 'ni ha', 'ni hao'].entries()) {
           if (i > 0) key229(true);
           await fire(new CompositionEvent('compositionupdate', { data: text, bubbles: true }));
           await fire(new InputEvent('input', { data: text, inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
           await new Promise((r) => setTimeout(r, 30));
       }
       key229(true);
       if (ORDER === 'webkit') {
           // WebKit commit path (Editor::setComposition(text, ConfirmComposition)): delete + insert, then compositionend; no final compositionupdate
           await fire(new InputEvent('input', { data: null, inputType: 'deleteCompositionText', isComposing: true, bubbles: true }));
           await fire(new InputEvent('input', { data: '你好', inputType: 'insertFromComposition', isComposing: true, bubbles: true }));
       } else {
           // Chromium commit path: a final compositionupdate carries the committed text
           await fire(new CompositionEvent('compositionupdate', { data: '你好', bubbles: true }));
           await fire(new InputEvent('input', { data: '你好', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
       }
       await fire(new CompositionEvent('compositionend', { data: '你好', bubbles: true }));
   })('webkit');
   ```

3. Wait about half a second, press Cmd/Ctrl+Z, then Cmd/Ctrl+Shift+Z.
4. Optional: repeat in the first cell of a 1 × 2 table (`univerAPI.executeCommand('doc.command.create-table', { rowCount: 1, colCount: 2 })`, caret at `dataStream.indexOf('\x1c') + 1`).

### Expected behavior

- After step 2: `Second 你好paragraph for undo tests.`
- Undo: `Second paragraph for undo tests.`
- Redo: `Second 你好paragraph for undo tests.`

### Actual behavior

WebKit order (identical in Chromium 153.0.8010.12, Chrome 153.0.8010.53 and WebKit 26.6, Univer 1.0.1):

- After step 2: `Second 你好paragraph for undo tests.` (correct)
- Undo: `Second graph for undo tests.` — six characters (`你好` + `para`) removed
- Redo: `Second ni haograph for undo tests.`
- In a table cell: undo removes `你好` together with the cell's paragraph mark, section break, cell end and the next cell's start (`\r\n\x1D\x1C`), so the two cells are merged; redo inserts `ni hao`.

Chromium order (`'chrome'`): undo and redo give the expected results, in the paragraph and in the cell.

In an earlier matrix on 1.0.0 (5 input sequences at the end of a paragraph, plus pinyin at 8 caret positions: start/middle of a paragraph, heading, list item, table cell, bold text, link text, replacing a selection — 13 cases) undo and redo were wrong in 11 of 13 cases with the WebKit order; the two correct cases are a cancelled composition and a composition whose committed text equals the last update (`hello` committed with Enter). With the Chromium order all 13 were correct.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag (unchanged in the published 1.0.1 and 1.0.2 packages).

1. `packages/docs-ui/src/controllers/render-controllers/doc-ime-input.controller.ts`, `_updateContent()`:
   - L154–158: when `compositionend.data` equals the previous composition text (Chromium order), `_finalizeComposition()` emits an end state with empty actions and `isCompositionEnd: true`.
   - L160–166: otherwise (WebKit order) `IMEInputCommand` is executed with the committed text and `isCompositionEnd: true`.
2. `packages/docs-ui/src/commands/commands/ime-input.command.ts` L261–270: for that final step `noHistory` is `false` and `isCompositionEnd` is `true`; `RichTextEditingMutation` runs through `syncExecuteCommand()` (L265–268), and only afterwards the step's undo/redo params are cached with `pushUndoRedoMutationParams(result, doMutation.params)` (L270).
3. `packages/docs/src/commands/mutations/core-editing.mutation.ts` L394 emits the state change synchronously inside the mutation; `packages/docs/src/services/doc-state-change-manager.service.ts` L136–154 immediately runs the interceptor; `packages/docs-ui/src/services/doc-ime-state-change-interceptor.service.ts` L27–66 replaces the history entry with `fetchComposedUndoRedoMutationParams()` (L40; composition in `packages/docs-ui/src/services/doc-ime-input-manager.service.ts` L103–141).
4. At that moment the cache holds the steps up to the last `compositionupdate` (`n` … `ni hao`) but not the final replacement `ni hao → 你好`. The composed undo is therefore "delete the 6 characters of `ni hao`" and the composed redo is "insert `ni hao`" — exactly what we observe.

In the Chromium order the final replacement is done by a `compositionupdate` (cached as a `noHistory` step), so the composed entry is complete when `_finalizeComposition()` emits the end state.

The WebKit sequence: `Source/WebCore/editing/Editor.cpp`, `Editor::setComposition(const String&, SetCompositionMode)` with `ConfirmComposition` calls `TypingCommand::deleteSelection(…, TextCompositionType::Pending)`, then `insertTextForConfirmedComposition(text)`, then dispatches `compositionend` with the confirmed text; this path dispatches no `compositionupdate` (WebKit `main`, checked 2026-09-28). WebKit's layout test expectation `input-events-ime-composition-expected.txt` (commit [1aeb332](https://github.com/WebKit/WebKit/commit/1aeb3328d18ee0392e7a2942315d06cbbdc1b0e6), "Support InputEvent.isComposing") shows the same order: `beforeinput`/`input` `deleteCompositionText`, `beforeinput`/`input` `insertFromComposition`, `compositionend`.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. v1.0.1 and v1.0.2 contain no source changes in these files; `dev` has no later commits to them either (checked 2026-09-28).
- Browsers: Chromium 153.0.8010.12 (Playwright build), Google Chrome 153.0.8010.53, WebKit 26.6 (Playwright build) — headless via Playwright 1.63.0, synthetic composition events as above. Desktop Safari with a system IME: _pending_.
- OS: macOS 27.0 (Apple M4 Pro) for the 1.0.1 runs on 2026-09-28; macOS 26.5.1 for the earlier 1.0.0 runs.

### Suggested fix

- In `DocIMEInputController`, handle a `compositionend` whose data differs from the last update as "update to the final text, then finalize": run the update path (`isUpdate = true`, cached as a `noHistory` step) and then call `_finalizeComposition()`. Or,
- in `IMEInputCommand`, make sure the final step's undo/redo params are in the cache before the end state is intercepted (e.g. execute the final step with `noHistory: true` like the updates, then emit the end state).
- Add a unit test with the WebKit event sequence (`deleteCompositionText` / `insertFromComposition` / `compositionend` without a final `compositionupdate`).
