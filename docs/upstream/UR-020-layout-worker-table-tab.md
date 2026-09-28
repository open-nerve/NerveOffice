# UR-020 排版 Worker 模式下，在表格单元格里键入后立即按 Tab，Tab 被吞掉

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P5 报告 §5.3 第 4 条、§6"上游报告"第 10 条；审查报告 R2；插件档案 v1 §2；用例 `spikes/m0/e2e/v13-capabilities.spec.ts` 的 C5"单元格中键入，Tab 移到下一格"（`M0_P5_QUERY=worker=1` 变体，结果 `spikes/m0/e2e/results/v13/capabilities-worker/*-C5-platform.json`）；DEF-007｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：已安装的 `@univerjs/docs-ui@1.0.1` 发布包里，表格的 Tab 规则仍要求选区带 `startNodePosition`（`if (startNodePosition && !endNodePosition && startNodePosition.path.indexOf("cells") > -1) return true;`），选区渲染在编辑锚点排版完成之前仍然推迟（`progress.reason === "edit" && !progress.anchorReady`）；`@univerjs/docs@1.0.1` 的 `scheduleDocumentSelectionUpdate` 仍先写入只有偏移量的逻辑选区；1.0.2 同样；GitHub dev 分支上 `doc-auto-format.controller.ts`、`doc-selection-render.service.ts`、`core-editing.mutation.ts` 自 2026-09-22 起没有新提交。注意：根因是按源码推断的，没有插桩验证）

## 摘要（中文）

启用文字文档的排版 Worker（`UniverDocsLayoutWorkerPlugin`）后，在表格单元格里键入后立即按 Tab，Tab 被吞掉、光标留在原来的单元格，接着键入的字写进同一格（期望"甲一 | 甲二"，实际"甲一甲二"）。Chromium 与 Chrome 上复现；WebKit 在同一轮没有复现（与时序有关）。审查时的探针显示：等 100 ms（约 2 万字的样本）或 200 ms（小样本）再按 Tab 就正常；键入后立即按方向键、回车正常；主线程排版下任何等待时间都正常。对用户：快速录入表格时内容写错格，而且没有任何提示。平台的规避：v0.1 不启用排版 Worker，用主线程排版（插件档案 v1 §2），代价是放弃 Worker 对主线程阻塞的改善（约 2 万字的样本上，快速键入时的最长阻塞从约 81–123 ms 降到 25–51 ms）；DEF-007 在 M6 重新评估，前提之一就是这个缺陷修复（上游修复，或者平台在排版结果发布之前把 Tab 等导航键排到发布之后）。证据状况：记录是在平台配置下取得的（平台只处理 `/` 键、输入法事件与若干命令守卫，与 Tab、表格导航无关），SDK 默认配置加 Worker 的重跑、StackBlitz 复现链接与 `npx envinfo` 输出待补充；上游自己的文字文档示例默认注册了这个插件，按源码推断在示例里也会复现，尚未验证。

## 已有的上游讨论

没有找到（GitHub issue 检索，关键词：`layout worker tab`、`layout worker`、`docs worker`、`UniverDocsLayoutWorkerPlugin`、`layout worker selection`、`incremental layout`、`incremental layout selection`、`tab table cell docs`、`tab-in-table`、`Tab next cell`、`tab key table`、`docs table tab key`、`worker tab lost`、`startNodePosition`、`表格 Tab 文档`；另用 WebSearch 检索网页；2026-09-28）。相关：[#7433](https://github.com/dream-num/univer/pull/7433)（feat(docs): add incremental layout worker，2026-08-28 合并：引入排版 Worker，以及"逻辑光标先行、排版结果随后发布"的做法）；[#3064](https://github.com/dream-num/univer/pull/3064)（feat(docs): tab in table，2024 年，已关闭，表格 Tab 的最初实现）；[#7670](https://github.com/dream-num/univer/pull/7670)（feat(docs): integrate table of contents and Office layout fidelity，2026-09-17 合并，早于 1.0.0 的发布；其中一项是"折叠光标的导航（含 Ctrl+Home / Ctrl+End）先等屏幕外的页面排版完成"，思路相近，但不涉及 Tab 与表格单元格）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Docs with `UniverDocsLayoutWorkerPlugin`: Tab pressed right after typing in a table cell is swallowed, and the next characters go into the same cell

### Describe the bug

With the Docs layout Worker enabled, typing in a table cell and pressing Tab immediately does not move the caret to the next cell. The key is consumed (no navigation, no tab character), so the text typed next is appended to the same cell. Pressing Tab a little later (≈100–200 ms after the last keystroke) works, and without the layout Worker Tab always works.

### To reproduce

Reproduction link: 【待补充：提交前把下面的片段放进官方 StackBlitz 模板（改用 Docs 预设并注册排版 Worker），生成复现链接】

1. Set up Docs (1.0.1) with the layout Worker, registered the same way as in `examples/src/docs/mount.ts`:

   ```ts
   // main.ts
   import { UniverDocsLayoutWorkerPlugin } from '@univerjs/docs';
   import { createUniver, getDocsEmptySnapshot, LocaleType, mergeLocales } from '@univerjs/presets';
   import { UniverDocsCorePreset } from '@univerjs/preset-docs-core';
   import DocsCoreEnUS from '@univerjs/preset-docs-core/locales/en-US';
   import '@univerjs/preset-docs-core/lib/index.css';

   const { univer, univerAPI } = createUniver({
       locale: LocaleType.EN_US,
       locales: { [LocaleType.EN_US]: mergeLocales(DocsCoreEnUS) },
       presets: [UniverDocsCorePreset({ container: 'app' })],
   });
   univer.registerPlugin(UniverDocsLayoutWorkerPlugin, {
       workerFactory: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
   });
   univerAPI.createDocument(getDocsEmptySnapshot());
   ```

   ```ts
   // worker.ts
   import { startDocsLayoutWorker } from '@univerjs/docs';

   startDocsLayoutWorker();
   ```

2. Insert a table: **Insert → Table → Insert Table**, 3 rows × 4 columns, and click into the first cell.
3. Type two characters, press Tab immediately, then type two more characters. By hand this needs Tab within roughly 100–200 ms of the last keystroke; we automated it with Playwright:

   ```ts
   await page.keyboard.type('甲一', { delay: 30 });
   await page.keyboard.press('Tab'); // no wait
   await page.waitForTimeout(200);
   await page.keyboard.type('甲二', { delay: 30 });
   ```

4. Expected: first cell `甲一`, second cell `甲二`. Actual: first cell `甲一甲二`, second cell empty.

### Expected behavior

Tab moves the caret to the next cell (Shift+Tab to the previous one) no matter how soon it follows the previous keystroke — as it does without the layout Worker.

### Actual behavior

Observed on 1.0.0 in a small document (about 80 characters) with a 3 × 4 table:

- Chromium 153 and Chrome 153: the first cell contains `甲一甲二` and the second cell is empty.
- WebKit 26.6: not reproduced in the same run (timing dependent).
- Pressing Tab ≥100 ms (in a document of about 20,000 characters) or ≥200 ms (in the small document) after the last keystroke works; arrow keys and Enter immediately after typing work in both layout modes; without `UniverDocsLayoutWorkerPlugin`, Tab works at any delay.

Shift+Tab goes through the same auto-format rule, so it is probably affected too (not measured).

### Root cause analysis

Suspected cause, from reading the source (line numbers refer to the `v1.0.0` tag); we have not confirmed it with instrumentation.

1. Tab is a shortcut for `doc.command.tab` (`packages/docs-ui/src/shortcuts/format.shortcut.ts` L22–35). When a shortcut matches, the shortcut service executes the command and calls `preventDefault()` regardless of what the command does (`packages/ui/src/services/shortcut/shortcut.service.ts` L306–313).
2. `TabCommand` (`packages/docs-ui/src/commands/commands/auto-format.command.ts` L27–36) runs the commands returned by the first matching auto-format rule; when no rule matches it does nothing (`packages/docs-ui/src/services/doc-auto-format.service.ts` L81–104).
3. The table rule (`packages/docs-ui/src/controllers/doc-auto-format.controller.ts` L92–129) only matches when the active range carries render-derived node positions that place it in a table cell (`startNodePosition` + `endNodePosition` in the same cell, or a `startNodePosition` whose `path` contains `'cells'`, L107–113). `DocTableTabCommand` itself only needs offsets and the view model (`packages/docs-ui/src/commands/commands/table/doc-table-tab.command.ts` L29–92).
4. Right after typing, the active range is plain offsets: `InsertTextCommand` builds its `textRanges` without node positions (`packages/docs/src/commands/commands/core-editing.command.ts` L86–90), and `scheduleDocumentSelectionUpdate()` stores them as the logical selection and refreshes the rendered selection in a microtask (`packages/docs/src/commands/mutations/core-editing.mutation.ts` L237–277).
5. With the layout Worker, `supportsIncrementalLayout()` is true (it requires a registered layout executor, `packages/docs/src/services/doc-skeleton-manager.service.ts` L94–101 and L141–149; only `UniverDocsLayoutWorkerPlugin` registers one, `packages/docs/src/layout-worker/index.ts` L300–313). While `layoutProgress.reason === 'edit' && !anchorReady`, `DocSelectionRenderService.replaceDocRanges()` keeps the selection pending and does not build `TextRange`s (`packages/docs-ui/src/services/selection/doc-selection-render.service.ts` L290–321), so no range with node positions is published until the layout of the edit anchor is published.
6. A Tab pressed inside that window therefore sees a range without `startNodePosition`, the table rule does not match, and the key is swallowed. With main-thread layout, `reRender()` recalculates the skeleton synchronously (`packages/docs-ui/src/controllers/render-controllers/doc.render-controller.ts` L580–627, the `recalculate()` branch at L605–608), so the microtask refresh can publish node positions before the next keydown.

The same code is present in the published 1.0.1 and 1.0.2 packages (`@univerjs/docs-ui`, `@univerjs/docs`). Note that the official Docs example registers `UniverDocsLayoutWorkerPlugin` by default (`examples/src/docs/mount.ts` L59–61).

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. The runtime observations were made on 1.0.0; the code quoted above is unchanged in the published 1.0.1 and 1.0.2 packages.
- Browsers: reproduced in Chromium 153.0.8010.12 (Playwright build) and Google Chrome 153.0.8010.53; not reproduced in the same run in WebKit 26.6 (Playwright build). All headless via Playwright 1.63.0. Our app also had a capture-phase listener that only handles the `/` key and IME events, plus `BeforeCommandExecute` guards for unrelated commands; none of them involve Tab or table navigation.
- OS: macOS 26.5.1 (Apple M4 Pro)

### Suggested fix

- Decide "the caret is in a table cell" from the logical offsets — the body's `tables` / the view model, which `getCellOffsets()` already uses — instead of the render-derived `startNodePosition`, so that the rule also works while the selection publication is pending.
- Or queue Tab / Shift+Tab (and other shortcuts that depend on the published selection geometry) until the pending edit anchor has been published.
- Other checks that read `startNodePosition` from `getDocRanges()` may have the same window — for example `hasRangeInTable()` in `InnerPasteCommand`, which decides whether pasting a table into the current position is refused; we have not verified this.
