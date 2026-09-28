# UR-004 `clear-drawing-transformer` 的命令类型声明为 `MUTATION`（应为 operation 一类）

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P3 报告 §2.1 第 4 条（`docs/v0.1/M0-技术验证/reports/P3-验证报告.md`）；插件档案 v1 §5.3（`docs/v0.1/M0-技术验证/reports/插件档案v1.md`）；用例 `spikes/m0/e2e/v06-actions.spec.ts`（`insert-image`、`move-image`），结果 `spikes/m0/e2e/results/v06/actions/*-sheet-insert-image*.json`、`*-sheet-move-image*.json`；P3 交接单"上游报告"｜发现版本：1.0.0｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/sheets-drawing@1.0.1` `lib/es/index.js` 第 136–138 行仍为 `type: CommandType.MUTATION`（另见 M1-P4 设计 §3.9：1.0.1 的产物与 1.0.0 相同）；`@univerjs/docs-drawing-ui` 本机没有安装 1.0.1，按 GitHub 上 `v1.0.1` 标签的源码核对，仍声明为 `IMutation<string[]>`、`CommandType.MUTATION`；GitHub 上 `dev` 分支与 `v1.0.2` 标签（表格这一条，2026-09-28）也没有改

## 摘要（中文）

`sheet.operation.clear-drawing-transformer`（`@univerjs/sheets-drawing`）与 `doc.operation.clear-drawing-transformer`（`@univerjs/docs-drawing-ui`）的 id、常量名与所在目录都表明它们是 operation，处理函数也只刷新画布上的图片变换框（`debounceRefreshControls()`），但类型声明为 `CommandType.MUTATION`。按 SDK 自己的定义，MUTATION 是"对保存在快照中的数据的修改"、协同冲突处理的最小单位。插入、移动浮动图片时，它作为不带 `onlyLocal` 的 mutation 随真正的数据 mutation 一起出现（M0-P3 在三个浏览器、主线程与 Worker 模式下都看到）；行高、列宽或行列显隐变化之后刷新图片位置的路径会单独执行它（按源码）。按"非本地 mutation 即内容修改"做变更检测、自动保存、mutation 日志的集成会把它当成修改，协同钩子 `onMutationExecutedForCollab` 也会收到它；它的参数是 unitId 数组，没有 `unitId` 字段，按单元过滤也失效。影响是误报"有修改"，不损坏数据，严重程度低。文字文档那一条在开源包里只注册、没有找到调用方，M0-P3 插入文字文档图片时也没有出现。平台在变更检测里维护排除名单（`CHANGE_DETECTION_EXCLUDED_MUTATIONS`，`apps/web/src/editor/profile/sheet-profile.ts`），随 SDK 版本由 E2E 回归。

## 已有的上游讨论

没有找到（2026-09-28 检索）。检索用的关键词：`clear-drawing-transformer`、`ClearSheetDrawingTransformerOperation`、`drawing transformer mutation`、`transformer operation is:issue`（GitHub 搜索接口）。搜到的 [#7625](https://github.com/dream-num/univer/pull/7625)（fix(docs): clear drawing popup after deletion，已关闭）处理的是文字文档里图片弹窗的销毁，与本问题无关。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] `sheet.operation.clear-drawing-transformer` and `doc.operation.clear-drawing-transformer` are declared as `CommandType.MUTATION` although they only refresh the transformer UI

### Describe the bug

`ClearSheetDrawingTransformerOperation` (`@univerjs/sheets-drawing`) and `ClearDocDrawingTransformerOperation` (`@univerjs/docs-drawing-ui`) are named and filed as operations (`*.operation.*` ids, `commands/operations/` folders), and their handlers only call `scene.getTransformer()?.debounceRefreshControls()` for the given units. However, both are declared as `IMutation<string[]>` with `type: CommandType.MUTATION`.

Univer's own definition (`packages/core/src/services/command/command.service.ts`) says an OPERATION is "the change made to data that is not saved to snapshot", while a MUTATION is "the change made to the data saved to snapshot … the smallest unit of conflict resolution". Because of the wrong type, this UI refresh is delivered as a non-local MUTATION:

- integrations that treat non-local mutations as document changes (dirty flag, autosave, mutation logs), for example by filtering the public `CommandExecuted` Facade event on `CommandType.MUTATION`, see a change where there is none;
- `onMutationExecutedForCollab` listeners receive it as well;
- its params are a plain `string[]` of unit ids without a `unitId` field, so the usual per-unit filtering (`params.unitId`) does not apply to it.

It is emitted together with real drawing mutations (insert, move, flip, group and ungroup, placement changes, and so on), and, by code reading, also on its own: after row/column size or visibility mutations, `SheetDrawingTransformAffectedController` refreshes drawing transforms in memory and then executes it without any data mutation.

### To reproduce

Reproduction link: 【待补充：提交前在官方 StackBlitz 模板（加上表格图片插件）里按下面的片段生成复现链接】

1. Use sheets with the drawing plugins (e.g. `UniverSheetsDrawingPreset`, or `@univerjs/sheets-drawing` + `@univerjs/sheets-drawing-ui`).
2. Run:

   ```ts
   import { CommandType } from '@univerjs/core';

   univerAPI.addEvent(univerAPI.Event.CommandExecuted, (e) => {
       if (e.type === CommandType.MUTATION) console.log(e.id, JSON.stringify(e.params), e.options);
   });
   const ws = univerAPI.getActiveWorkbook()!.getActiveSheet();
   await ws.insertImage(IMAGE_URL, 12, 12); // any image the page can load, e.g. a data: URL
   await ws.getImages()[0].setPositionAsync(20, 14);
   ```

3. Look at the MUTATIONs logged for each action.

【待补充：上面的片段是按我们在 1.0.0 验证工程里的调用（同样的 `insertImage`、`setPositionAsync`）整理的，还没有在官方模板里原样跑过】

### Expected behavior

Only real data mutations are reported as `CommandType.MUTATION` (here `sheet.mutation.set-drawing-apply`). Refreshing the transformer is an OPERATION, like other UI-only commands.

### Actual behavior

For both inserting a floating image (`FWorksheet.insertImage`) and moving it (`setPositionAsync`), the `CommandExecuted` event delivered two MUTATIONs: `sheet.mutation.set-drawing-apply` and `sheet.operation.clear-drawing-transformer`, the latter with no execution option set (in particular not `onlyLocal`). We observed this on 1.0.0 in Chromium 153.0.8010.12, Chrome 153.0.8010.53 and WebKit 26.6, with formulas on the main thread and in a Web Worker. According to the source, its params are `[unitId]`.

`doc.operation.clear-drawing-transformer` has the same declaration; it is registered by `@univerjs/docs-drawing-ui`, but we did not find a caller in the open-source packages, and inserting an image into a document (`FDocument.insertImage`) did not emit it in our tests.

### Root cause analysis

Paths are relative to the repository root; line numbers refer to tag v1.0.0.

- `packages/sheets-drawing/src/commands/operations/clear-drawing-transformer.operation.ts` L21-33 and `packages/docs-drawing-ui/src/commands/operations/clear-drawing-transformer.operation.ts` L21-33: `IMutation<string[]>`, `type: CommandType.MUTATION`; the handler only refreshes the transformer controls.
- `packages/core/src/services/command/command.service.ts` L44-54: definitions of OPERATION and MUTATION; L454-459 and L515-520: every executed MUTATION (unless `syncOnly`) goes to the `onCommandExecuted` listeners (the Facade `CommandExecuted` event) and to `onMutationExecutedForCollab`.
- Callers in redo/undo lists, e.g. `packages/sheets-drawing/src/commands/commands/insert-sheet-drawing.command.ts` L65 and L83, `set-sheet-drawing.command.ts` L128 and L146, `remove-sheet-drawing.command.ts` L75 and L93, `set-sheet-drawing-placement.command.ts` L68 and L75, `packages/sheets-drawing-ui/src/commands/commands/flip-drawings.command.ts` L161-162, `group-sheet-drawing.command.ts` L65 and L69, `ungroup-sheet-drawing.command.ts` L60 and L64.
- Direct executions: `packages/sheets-drawing-ui/src/commands/commands/move-drawings.command.ts` L84-86 (nudging a selected drawing with the arrow keys, `controllers/shortcuts/drawing.shortcut.ts`), and `packages/sheets-drawing/src/controllers/sheet-drawing-transform-affected.controller.ts` L1395-1428 together with L331-337: after row/column size or visibility mutations, changed drawing transforms are refreshed through `refreshTransform()` (no data mutation) and then `ClearSheetDrawingTransformerOperation` is executed, so it is the only mutation emitted by that path.
- Registration: `packages/sheets-drawing/src/controllers/sheet-drawing.controller.ts` L77-87, `packages/docs-drawing-ui/src/controllers/ui.controller.ts` L61-77.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. Affected packages: `@univerjs/sheets-drawing`, `@univerjs/docs-drawing-ui`. Unchanged on `dev` and in `v1.0.2` for the sheet variant (checked on 2026-09-28).
- Browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, Google Chrome 153.0.8010.53; all headless, driven by Playwright.
- OS: macOS 26.5.1 (Apple M4 Pro).

### Suggested fix

Declare both as operations:

```ts
export const ClearSheetDrawingTransformerOperation: IOperation<string[]> = {
    id: 'sheet.operation.clear-drawing-transformer',
    type: CommandType.OPERATION,
    handler: (accessor, params) => { /* unchanged */ },
};
```

(and the same for `ClearDocDrawingTransformerOperation`). Operations are already mixed into undo/redo lists elsewhere (e.g. `SetSelectionsOperation` in `packages/sheets/src/commands/commands/move-rows-cols.command.ts` L180-181), so undo/redo keeps working. If the MUTATION type is intentional — for example so that collaborators refresh their transformer as well — please document it, and consider giving the params a `unitId` field so that per-unit filters work.
