# UR-019 隐藏父菜单后，子项仍能被功能搜索找到

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P5 报告 §2.3 第 4 条、§5.1、§6"上游报告"第 9 条；审查报告 G6；用例 `spikes/m0/e2e/v13-layout-entries.spec.ts`（L3 菜单审计，结果 `spikes/m0/e2e/results/v13/layout/*-menus.json`，是修复之后的记录）；隐藏清单 `spikes/m0/src/profiles/ui-config.ts` 的 `DOC_UNSUPPORTED_MENUS`；没有 DEF｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：已安装的 `@univerjs/ui@1.0.1` 发布包里，功能搜索仍只按菜单结构的嵌套收集祖先（`schema.item ? [...ancestors, schema.item] : ancestors`），菜单配置仍只作用于带菜单项的节点（`if (item) menuItem.item = config ? mergeMenuConfigs(item, config) : item;`），右键菜单仍按父项 id 另行查找子菜单（`getMenuByPositionKey(menuItem.id)`）；npm 上 `@univerjs/docs-drawing-ui@1.0.1` 的形状子项仍注册在以父项 id 为键的独立节点下；1.0.2 同样；GitHub dev 分支上 `FeatureSearch.tsx` 自 2026-09-22 起没有新提交）

## 摘要（中文）

用菜单配置隐藏一个带子菜单（SUBITEMS）的父菜单项之后——例如文字文档的"插入图形"（`doc.command.menu-insert-shape`）——段落菜单里看不到它，它的子菜单也就打不开；但"搜索功能"对话框（Ctrl/Cmd+Shift+P）仍然列出子项"插入矩形""插入椭圆"，选中就执行对应的命令。集成方按菜单隐藏的功能从另一个入口露了出来。这不是安全问题：隐藏菜单本来就不停用命令（快捷键与 API 仍可执行），平台另有命令守卫。平台的规避：隐藏清单把形状的 4 个子项与父项一起列出（`DOC_UNSUPPORTED_MENUS`，共 30 项），并用命令守卫取消形状命令；M0 的菜单审计用 14 个搜索词确认隐藏项都搜不到，生产实现在 M6。代价：每个带子菜单的父项都要手工列出子项的 id，SDK 升级新增子项时容易漏，只能靠菜单审计用例发现。证据状况：修复之前"子项能被搜到"的观察来自审查（审查报告 G6，探针未入库，当时的浏览器没有记录）；入库的菜单审计结果是修复之后的；源码可以完整解释这个现象（见正文）。提交前需要在 SDK 默认配置下补截图、StackBlitz 复现链接与 `npx envinfo` 输出（待补充）。

## 已有的上游讨论

相关：UR-028（同一个组件：工作簿不可编辑时"搜索功能"照样打开、列出没有按权限停用的编辑功能，不看 `toolbar`/`contextMenu: false`，也关不掉；2026-10-02 起草）。

没有找到（GitHub issue 检索，关键词：`feature search hidden`、`"feature search"`、`featureSearch`、`FeatureSearch`、`open-feature-search`、`"search features"`、`command palette`、`menu hidden submenu`、`menu config hidden children`、`menu hidden config`、`hidden$ menu search`、`SUBITEMS hidden`、`hidden menu still searchable`、`功能搜索`、`搜索功能 菜单 隐藏`；另用 WebSearch 检索网页；2026-09-28）。相关但不是同一个问题：[#2419](https://github.com/dream-num/univer/issues/2419)（[Bug] Failing To Hide Menu Items，v0.1.13 的工具栏隐藏配置不生效，2024 年已关闭，那时还没有功能搜索）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Feature Search still lists and runs the children of a SUBITEMS menu that is hidden via the `menu` config

### Describe the bug

Hiding a submenu parent (`MenuItemType.SUBITEMS`) with the `menu` config removes it from the context / paragraph menu, so its children can no longer be reached there. The Feature Search dialog (`ui.operation.open-feature-search`, Ctrl/Cmd+Shift+P) still lists those children and executes them when selected.

Example in Docs: with `doc.command.menu-insert-shape` ("Insert Shape") hidden, "Insert Rectangle" and "Insert Ellipse" are still found by Feature Search, and selecting one runs `doc.command.insert-float-shape.rectangle` / `doc.command.insert-float-shape.ellipse`.

Feature Search does honor hidden and disabled ancestors, but only ancestors in the same schema subtree. SUBITEMS children are registered in a separate schema node keyed by the parent's id, so the parent's `hidden$` is never consulted for them.

### To reproduce

Reproduction link: 【待补充：提交前把下面的片段放进官方 StackBlitz 模板（改用 Docs 预设），生成复现链接】

Screenshots: 【待补充：SDK 默认配置下，功能搜索列出"Insert Rectangle"并插入矩形的截图】

1. Set up Docs with the core and drawing presets (1.0.1) and hide the shape submenus:

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
       presets: [
           UniverDocsCorePreset({
               container: 'app',
               menu: {
                   'doc.command.menu-insert-shape': { hidden: true },
                   'doc.command.menu-insert-shape.below': { hidden: true },
               },
           }),
           UniverDocsDrawingPreset(),
       ],
   });
   univerAPI.createDocument(getDocsEmptySnapshot());
   ```

2. Click into the document. "Insert Shape" no longer appears in the paragraph menu, as configured.
3. Press Ctrl/Cmd+Shift+P (**Search features**) and type `Rectangle` (or `Ellipse`).
4. "Insert Rectangle" is listed. Selecting it executes `doc.command.insert-float-shape.rectangle`, which inserts a rectangle shape into the document.

### Expected behavior

Items whose SUBITEMS parent is hidden (or disabled) are not offered by Feature Search — consistent with the context menu, where they are unreachable once the parent is hidden. Alternatively, a `menu` config entry for a SUBITEMS id could apply to all of its children.

### Actual behavior

The children of the hidden parent are listed by Feature Search and can be executed from there. In our app the command was additionally cancelled by our own `BeforeCommandExecute` guard, so nothing was inserted; without such a guard the command inserts a shape (we verified that by executing `doc.command.insert-float-shape.rectangle` / `.ellipse` directly: each inserts one drawing). We had to list every child id in the `menu` config as well (four shape items) to hide them from Feature Search.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag.

- `packages/docs-drawing-ui/src/menu/schema.ts`: the parent item `DOCS_SHAPE_MENU_ID` (a SUBITEMS item, `menu/shape.menu.ts` L30–39) is registered under the paragraph menu's insert group (L72–83), while its children are registered under a separate node keyed by the parent's id, `[ContextMenuPosition.PARAGRAPH][DOCS_SHAPE_MENU_ID].shapes` (L96–121; same for the `.below` variant).
- `packages/ui/src/views/components/context-menu/ContextMenuPanel.tsx` L1163–1169: the context menu resolves the children of a SUBITEMS item with `menuManagerService.getMenuByPositionKey(menuItem.id)`, so hiding the parent makes them unreachable there.
- `packages/ui/src/services/menu/menu-manager.service.ts` L365–408 (`_buildMenuSchema()`): the node keyed by the parent id has no `menuItemFactory`, so no item is created for that node and the `menu` config entry for that id has nothing to apply to there — it only reaches the parent item registered in the insert group (config is only merged when an item exists, L374–391; `mergeMenuConfigs()` in `packages/ui/src/common/menu-merge-configs.ts` L20–39 turns `hidden: true` into `hidden$`).
- `packages/ui/src/views/components/feature-search/FeatureSearch.tsx`: `collectCandidates()` (L97–142) walks the ribbon and `CONTEXT_MENU` schemas (L215–243) and derives `ancestors` only from structural nesting (`schema.item ? [...ancestors, schema.item] : ancestors`, L135). For the shape items the ancestor list is empty, so `observeCandidate()` (L144–213, ancestor check at L151–171) never sees the hidden parent and lists them.

This is not specific to Docs shapes: any SUBITEMS menu whose children live in a parent-id-keyed node should behave the same way (we only checked the Docs shape menus). The same code is present in the published 1.0.1 and 1.0.2 packages (`@univerjs/ui`, `@univerjs/docs-drawing-ui`).

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. The observation was made on 1.0.0; the code quoted above is unchanged in the published 1.0.1 and 1.0.2 packages.
- Browsers: browser-independent (menu schema logic); observed in a headless Playwright browser from our test matrix (Chromium 153.0.8010.12, Google Chrome 153.0.8010.53, WebKit 26.6; Playwright 1.63.0).
- OS: macOS 26.5.1 (Apple M4 Pro)

### Suggested fix

- In `collectCandidates()`, treat SUBITEMS items like the context menu does: resolve their children with `getMenuByPositionKey(item.id)`, pass the parent item as an ancestor, and skip (or de-duplicate) the separate parent-id-keyed node when walking the tree.
- Or make `_buildMenuSchema()` apply a `menu` config entry of an id-keyed node without an item (such as `doc.command.menu-insert-shape`) to its descendants, so that `hidden` / `disabled` of the parent reach the children.
