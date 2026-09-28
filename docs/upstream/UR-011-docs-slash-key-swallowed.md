# UR-011 正文里键入的 `/` 被吞掉（单元格里不弹菜单，空段落里菜单吞字）

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P5 报告 §2.3 第 1 条、§2.1"`/` 快捷插入"、§6"上游报告"第 1 条；用例 `spikes/m0/e2e/v13-capabilities.spec.ts`（C8b"`/` 键（SDK 默认，对照）"，结果 `spikes/m0/e2e/results/v13/capabilities/*-C8b-default.json`；C8 为平台配置）；审查报告 G1（不经过 `/` 键的输入）、G2（空段落里菜单吞字）、S2（单元格）；没有专属的 DEF（空段落里菜单吞字列为已知限制，由 M6 处理）｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：① GitHub 上 v1.0.0…v1.0.1 只改了 README 与各包 `package.json` 的版本号，v1.0.2 只升级了图标包；② 已安装的 `@univerjs/docs-ui@1.0.1` 发布包 `lib/es/index.js` 里，`_openSlashMenu` 仍先 `preventDefault()` 再找段落，`_shouldOpenSlashMenu` 仍只判断按键，建段落边界时仍跳过 `table-cell`，`/` 菜单仍 `autoFocus`；③ 2026-09-28 在只注册公开插件的最小页面上用 1.0.1 复跑，Chromium、Chrome、WebKit 都复现，结果见正文；dev 分支上这个文件在 #7696（2026-09-17）之后没有新提交）

## 摘要（中文）

在文字文档正文里键入 `/`，SDK 的段落菜单服务在任何位置都会拦下它并弹出 `/` 插入菜单：斜杠本身不进正文，菜单抢走键盘焦点，其后键入的字全部丢失（Chromium 内核里在一个词后面键入 ` a/b 2026/9/25` 只剩 ` a`；WebKit 里斜杠和部分字丢失）。表格单元格里斜杠同样被吞掉，但菜单不弹出。不经过 `/` 键的输入（系统文字替换等，走 input 路径）会把斜杠插进正文，但菜单照样弹出并吞掉其后的字。空段落里弹出菜单是预期行为，可其后键入的字同样丢失，要先按 Esc。影响：日期、网址、路径、"和/或"都无法正常键入，用户会悄悄丢字；SDK 没有配置开关。平台的规避：在捕获阶段拦下 `/` 的 keydown 与数据为 `/` 的 insertText beforeinput，只在表格之外的空段落里放行给 SDK 弹菜单，其他位置由平台执行插入文字的命令插入 `/`（沿用左侧文字的样式与所在链接）；空段落里菜单吞字仍是已知限制，M6 处理。

## 已有的上游讨论

没有找到报告这个问题的 issue（GitHub issue/PR 检索，关键词：`slash`、`slash menu`、`"slash command"`、`"paragraph menu"`、`斜杠`；另用 WebSearch 检索网页；2026-09-28）。相关、但没有解决这个问题的 PR：[#7072](https://github.com/dream-num/univer/pull/7072)（fix(docs): improve docs slash menu and shortcuts，2026-06 合并）；[#7696](https://github.com/dream-num/univer/pull/7696)（fix(docs-ui): stabilize paragraph menus and focus handoffs，2026-09-17 合并，已包含在 1.0.0 中：让 `/` 菜单保持打开直到显式关闭、关闭时归还焦点，没有加触发位置的判断，也没有处理菜单打开时的键入）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Docs: typing "/" anywhere in the body opens the slash menu and swallows the "/" and the following keystrokes (in table cells the "/" is dropped without a menu)

### Describe the bug

The Docs slash menu is triggered by every `/` typed into a collapsed selection, wherever the caret is:

- **Middle of a paragraph:** the `/` is not inserted, the slash menu opens and takes keyboard focus, and everything typed after it is lost. Typing ` a/b 2026/9/25` after a word leaves only ` a` (Chromium / Chrome). In WebKit the slashes and some characters are lost (` a 202625`).
- **Table cell:** the `/` is swallowed and no menu is shown (`a/b` becomes `ab`).
- **`/` inserted without a `/` keydown** (OS text replacement, `insertText` from assistive tools): the `/` is inserted, but the menu still opens and the next characters are lost.
- **Empty paragraph** (where the menu is expected): the characters typed right after `/` are lost as well; typing works again only after Esc.

So dates (`2026/9/25`), URLs, paths and "and/or" cannot be typed in normal text, and we found no configuration option to restrict the trigger.

### To reproduce

Reproduction link: _to be added (StackBlitz)_. We used the minimal setup below (public 1.0.1 packages only, no other plugins, no application code); the Docs demo in this repository's `examples/` workbench should behave the same.

<details><summary>Minimal setup</summary>

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

const text = 'First paragraph with some text.\rSecond paragraph.\rThird paragraph.\r\r\n';
const paragraphs = [...text].flatMap((c, i) => (c === '\r' ? [{ startIndex: i }] : []));
univer.createUnit(UniverInstanceType.UNIVER_DOC, {
    id: 'doc',
    body: { dataStream: text, paragraphs, sectionBreaks: [{ startIndex: text.length - 1 }], textRuns: [] },
    documentStyle: { pageSize: { width: 794, height: 1124 }, marginTop: 50, marginBottom: 50, marginLeft: 50, marginRight: 50 },
});
window.univerAPI = FUniver.newAPI(univer);
```

</details>

1. Click right after `some text` in the first paragraph and type ` a/b 2026/9/25`.
2. Press Esc. Click into the empty last paragraph, type `/`, then `abc`. Press Esc and type `x`.
3. With the caret in the empty last paragraph, insert a 1 × 2 table (Insert → Table, or `univerAPI.executeCommand('doc.command.create-table', { rowCount: 1, colCount: 2 })`), click into the first cell and type `a/b`.
4. (Chromium) Put the caret in the middle of a word and insert `/` without pressing the key — e.g. through an OS text replacement, or with CDP `Input.insertText({ text: '/' })` — then type `xyz`.

### Expected behavior

- A `/` typed inside text, and anywhere the slash menu does not apply (e.g. table cells), is inserted like any other character, and typing continues.
- The slash menu is triggered only where it is meant to be used (e.g. at the start of an empty paragraph), or it opens without swallowing the `/` and without taking the keystrokes that follow (e.g. typing filters the menu; Esc, space or "no match" closes it and keeps the text).
- When the menu cannot be shown, the key event is left untouched.

### Actual behavior

Observed on 1.0.1 with the setup above (same results on 1.0.0 in our earlier runs); no console errors:

| Step | Chromium 153 / Chrome 153 | WebKit 26.6 |
|---|---|---|
| 1. ` a/b 2026/9/25` after `some text` | paragraph becomes `First paragraph with some text a.`; the slash menu (Heading 1 … Insert Table, Paste) is open and focus is on the menu container | paragraph becomes `First paragraph with some text a 202625.`; no menu left open |
| 2. empty paragraph: `/` then `abc` | menu opens (expected); `abc` is lost; after Esc, `x` is inserted | menu opens; `a` is lost, `bc` inserted |
| 3. table cell: `a/b` | cell contains `ab`; no menu | cell contains `ab`; no menu |
| 4. `/` via `Input.insertText`, then `xyz` | `/` is inserted, the menu opens, `xyz` is lost | — (CDP only) |

### Root cause analysis

Line numbers refer to the `v1.0.0` tag (unchanged in the published 1.0.1 and 1.0.2 packages).

- `packages/docs-ui/src/services/doc-paragraph-menu.service.ts`
  - L385–403: every `onKeydown$` and every `onInputBefore$` event is passed to `_handleSlashMenuKeydown` / `_handleSlashMenuInputBefore`.
  - L447–466: `_shouldOpenSlashMenu` / `_shouldOpenSlashMenuFromInput` only check that the selection is collapsed and editable and that the key / data is `/` without modifiers. The caret position (start of an empty paragraph, inside a word, inside a table cell) is not considered.
  - L422–445: `_openSlashMenu` calls `config.event.preventDefault()` and `stopPropagation()` **before** resolving the paragraph (L426), and returns `true` when no paragraph or target is found (L427–429, L432–435). So the `/` is swallowed even when no menu can be shown.
- `packages/docs-ui/src/services/doc-event-manager.service.ts` L916–918: `_buildParagraphBoundsBySegment()` skips `table-cell` line contexts, so `paragraphBounds` has no entries for paragraphs in cells, and `_getSlashMenuParagraph()` (doc-paragraph-menu.service.ts L484–504) returns `null` for a caret in a cell unless the hover menu happens to be attached to that paragraph. Together with the early `preventDefault()` this drops the `/` without a menu. (This is our reading of the code; it matches what we observe.)
- `packages/docs-ui/src/views/ParagraphMenu.tsx` L1488–1489: the slash menu is rendered with `autoFocus={openMode === 'slash'}` and `autoFocusTarget="container"`, so focus leaves the editor's hidden input; the printable keys that follow are neither inserted nor used to filter the menu.
- Input path: `packages/docs-ui/src/services/selection/doc-selection-render.service.ts` L1524–1546 emits `onInputBefore$` from the `input` event, which is not cancelable, so `preventDefault()` has no effect there; `DocInputController` (`packages/docs-ui/src/controllers/render-controllers/doc-input.controller.ts` L76) inserts the `/`, and the menu opens anyway.
- `DocParagraphMenuService` is a render module registered by the Docs UI plugin; we found no option to turn the slash trigger off or restrict it.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. v1.0.1 and v1.0.2 contain no source changes in this area; on `dev`, `doc-paragraph-menu.service.ts` has no commits after #7696 (2026-09-17).
- Browsers: Chromium 153.0.8010.12 (Playwright build), Google Chrome 153.0.8010.53, WebKit 26.6 (Playwright build) — headless, driven by Playwright 1.63.0 with real keyboard input. Not checked in desktop Safari yet.
- OS: macOS 27.0 (Apple M4 Pro) for the 1.0.1 runs on 2026-09-28; macOS 26.5.1 for the earlier 1.0.0 runs.

### Suggested fix

- Open the slash menu only when the caret is at the start of an empty paragraph (and decide explicitly whether table cells are supported); otherwise leave the event alone so the `/` is inserted normally.
- In `_openSlashMenu`, resolve the paragraph and target first, and call `preventDefault()` only when the menu is actually shown.
- Alternatively insert the `/` and open a filterable menu anchored to it without moving focus away from the editor: typing filters, Esc / space / no match closes the menu and keeps the typed text.
- Expose an option on the Docs UI plugin to disable the slash menu or choose its trigger (e.g. `slashMenu: false | { trigger: 'empty-paragraph' | 'always' }`).
