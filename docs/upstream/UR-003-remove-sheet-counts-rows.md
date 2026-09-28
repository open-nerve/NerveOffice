# UR-003 删除工作表按行数判断"大表"，与复制时按单元格计数不一致，删除大表会清空整个撤销栈

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P3 报告 §2.3 第 5 条（第 129 行）与摘要（`docs/v0.1/M0-技术验证/reports/P3-验证报告.md`）；用例 `spikes/m0/e2e/v06-large-copy.spec.ts`（删除大工作表的部分），结果 `spikes/m0/e2e/results/v06/large-copy/*.json`（`removal.undoBefore`、`removal.undoAfterRemove`）；00 号计划书附录 B｜发现版本：1.0.0｜1.0.1 核对：仍然存在。依据：发布包 `@univerjs/sheets@1.0.1` `lib/es/index.js` 第 4701–4707 行（`countCells` 仍用 `forEach`）、第 13129 行与第 13160 行（删除时按它判断大表并清空撤销栈），`@univerjs/core@1.0.1` `lib/es/index.js` 第 8178–8186 行（`ObjectMatrix.forEach` 按行遍历），与 1.0.0 源码相同（另见 M1-P4 设计 §3.9：1.0.1 的产物与 1.0.0 相同）；2026-09-28 用 1.0.1 发布包在 Node.js 上复现（下文的脚本与输出）；GitHub 上 `dev` 分支与 `v1.0.2` 标签的源码（2026-09-28）也没有改

## 摘要（中文）

删除工作表时，SDK 用 `countCells(worksheet.getCellMatrix())` 判断是不是"大表"（默认阈值 6,000；配置说明写的是"单元格数"），但这个函数用 `ObjectMatrix.forEach` 计数，而 `forEach` 遍历的是行，所以实际是按"有数据的行数"判断；复制工作表时用的是文件内另一个真正按单元格计数的同名函数。后果有两面：5,000 行 × 10 列（5 万个单元格）的宽表删除时不算大表，整张表的数据进了撤销栈，按源码推断也不出现大表的删除警告；而只要有 6,000 行以上（哪怕只有 1 列）就算大表，删除之后整个工作簿的撤销、重做历史被清空。M0-P3 实测：删除 5,001 行（50,010 个单元格）的表，撤销记录照常压栈；删除约 13,300 行的表，撤销栈被清空（1→0）；2026-09-28 用 1.0.1 在 Node.js 上复现，连之前在另一张表上的修改也撤销不了。数据不受影响，但用户会意外失去全部撤销历史。平台把 `largeSheetOperation.largeSheetCellCountThreshold` 设为 `Number.MAX_SAFE_INTEGER`（`apps/web/src/editor/profile/sheet-profile.ts`），关掉了大表拆分与清空撤销栈，代价是大表复制、删除的撤销记录带上整表数据（占内存）。

## 已有的上游讨论

没有找到针对这个缺陷的 issue 或 PR（2026-09-28 检索）。检索用的关键词：`largeSheetCellCountThreshold`、`countCells`、`"large sheet"`、`remove sheet undo`、`remove sheet undo is:issue`、`delete sheet undo is:issue`、`clearUndoRedo`（GitHub 搜索接口），以及网页搜索"dream-num univer remove sheet undo cleared large sheet largeSheetCellCountThreshold"。

相关的历史：[#6214](https://github.com/dream-num/univer/pull/6214) feat(sheets): split insert sheet command on large data —— 已合并（2025-12-03），引入了大表拆分、删除大表不支持撤销，以及删除时的 `countCells(worksheet.getCellMatrix())`。[#6568](https://github.com/dream-num/univer/issues/6568)（已关闭，请求提供清空撤销栈的接口）与本问题无关。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Sheet removal compares the row count, not the cell count, with `largeSheetCellCountThreshold`; removing a sheet with ≥ 6,000 rows wipes the whole undo history

### Describe the bug

`ILargeSheetOperationConfig.largeSheetCellCountThreshold` is documented as "The minimum number of cells that defines a 'large sheet'" (default 6,000). Copying a worksheet counts cells, but removing a worksheet calls `countCells(worksheet.getCellMatrix())` from `packages/sheets/src/commands/commands/util.ts`, which counts with `ObjectMatrix.forEach` — and `forEach` iterates **rows**, not cells. So the removal command, and the delete confirmation dialog that uses the same function, compare the number of non-empty rows with the cell threshold.

Consequences:

- A wide sheet with fewer than 6,000 rows is never treated as large, however many cells it has (e.g. 5,000 rows × 10 columns = 50,000 cells). Its removal is pushed to the undo stack together with the whole sheet data and, by code reading, the large-sheet warning is not shown, while copying the same sheet does treat it as large (the copy is split into batches).
- Any sheet with at least 6,000 non-empty rows is treated as large, even with a single column. Removing it clears the undo/redo history of the whole workbook (`undoRedoService.clearUndoRedo(unitId)`), so the user also loses the undo steps of earlier, unrelated edits.

### To reproduce

Reproduction link: 【待补充：提交前放一个可运行的仓库或 StackBlitz（Node 模板）链接；下面的脚本已经在本地用 1.0.1 跑过】

Minimal example with public APIs only (Node.js; the same calls work in a browser):

```js
// node repro.cjs
const { LocaleType, LogLevel, Univer, UniverInstanceType } = require('@univerjs/core');
const { FUniver } = require('@univerjs/core/facade');
const { countCells, UniverSheetsPlugin } = require('@univerjs/sheets');
require('@univerjs/sheets/facade');

function sheet(id, name, rows, cols) {
    const cellData = {};
    for (let r = 0; r < rows; r++) {
        cellData[r] = {};
        for (let c = 0; c < cols; c++) cellData[r][c] = { v: r * cols + c };
    }
    return { id, name, rowCount: rows + 10, columnCount: Math.max(cols, 5), cellData };
}

const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} }, logLevel: LogLevel.WARN });
univer.registerPlugin(UniverSheetsPlugin); // default largeSheetOperation: largeSheetCellCountThreshold = 6000
univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
    id: 'wb',
    sheetOrder: ['keep', 'wide', 'tall'],
    sheets: {
        keep: { id: 'keep', name: 'Keep', rowCount: 20, columnCount: 5, cellData: {} },
        wide: sheet('wide', 'Wide', 5000, 10), // 50,000 cells in 5,000 rows
        tall: sheet('tall', 'Tall', 6000, 1), // 6,000 cells in 6,000 rows
    },
});
const univerAPI = FUniver.newAPI(univer);
const wb = univerAPI.getActiveWorkbook();
const names = () => wb.getSheets().map((s) => s.getSheetName()).join(', ');
const keepA1 = () => JSON.stringify(wb.getSheetByName('Keep').getRange('A1').getValue());

console.log('countCells(Wide) =', countCells(wb.getSheetByName('Wide').getSheet().getCellMatrix())); // 50,000 cells
console.log('countCells(Tall) =', countCells(wb.getSheetByName('Tall').getSheet().getCellMatrix())); // 6,000 cells

wb.getSheetByName('Keep').getRange('A1').setValue('first edit');

wb.deleteSheet(wb.getSheetByName('Wide'));
console.log('deleted Wide ->', names());
wb.undo();
console.log('undo ->', names()); // Wide is back: its 50,000 cells were kept in the undo stack

wb.deleteSheet(wb.getSheetByName('Tall'));
console.log('deleted Tall ->', names());
wb.undo();
console.log('undo ->', names(), '| Keep!A1 =', keepA1()); // Tall is not restored
wb.undo();
console.log('undo ->', names(), '| Keep!A1 =', keepA1()); // the earlier edit on Keep cannot be undone either

univer.dispose();
```

By code reading, deleting from the sheet tab menu goes through `RemoveSheetConfirmCommand` and then the same `RemoveSheetCommand`, and the confirmation dialog shows the large-sheet text for Tall (6,000 cells) but the normal text for Wide (50,000 cells). 【待补充：界面上的删除与确认对话框没有实测】

### Expected behavior

- `countCells()` returns the number of cells (50,000 for Wide), so removal applies the documented cell threshold in the same way as copy: whether a sheet is "large" depends on its cell count, not on its number of rows.
- Deleting a sheet should not silently discard the undo history of unrelated earlier edits. If clearing the whole history is the intended large-sheet behavior, it should at least be triggered by the documented measure, and the configuration docs and the confirmation dialog should say that all earlier undo steps are lost (today the dialog only says "It will not be retrieved after deletion").

### Actual behavior

Output of the script above (Node.js 24.21.0, published 1.0.1 packages):

```text
countCells(Wide) = 5000
countCells(Tall) = 6000
deleted Wide -> Keep, Tall
undo -> Keep, Wide, Tall
deleted Tall -> Keep, Wide
undo -> Keep, Wide | Keep!A1 = "first edit"
undo -> Keep, Wide | Keep!A1 = "first edit"
```

`countCells()` returns the row count (5,000) for a sheet with 50,000 cells. Wide is removed with an undo item containing the whole sheet; Tall is treated as large, and after removing it neither the removal nor the earlier edit on Keep can be undone.

In browsers (1.0.0; Chromium 153.0.8010.12, Chrome 153.0.8010.53, WebKit 26.6; main-thread and Worker formula modes) with the default threshold:

- removing a sheet of 5,001 rows × 10 columns (50,010 cells) pushed an undo item (undo stack 1 → 2);
- removing a sheet of about 13,300 rows × 20 columns (265,800 cells) cleared the undo stack (1 → 0);
- with `largeSheetOperation: { largeSheetCellCountThreshold: Number.MAX_SAFE_INTEGER }` both removals pushed an undo item (1 → 2).

### Root cause analysis

Paths are relative to the repository root; line numbers refer to tag v1.0.0.

- `packages/sheets/src/commands/commands/util.ts` L111-117: `countCells(cellMatrix)` increments once per `cellMatrix.forEach(...)` callback.
- `packages/core/src/shared/object-matrix.ts` L267-280: `ObjectMatrix.forEach` calls the callback once per **row** (`(row, objectArray)`); `forValue` (L304-325) is the per-cell iterator.
- `packages/sheets/src/commands/commands/remove-sheet.command.ts` L63-70: `isLargeSheet = countCells(worksheet.getCellMatrix()) >= largeSheetCellCountThreshold`; L78-81 and L87-89: no undo mutations for a large sheet; L92-102: `undoRedoService.clearUndoRedo(unitId)` for a large sheet, otherwise the full `InsertSheetMutation` is pushed as the undo item.
- `packages/sheets/src/commands/commands/copy-worksheet.command.ts` L53-65: copy uses its own `countCells(cellData)` that really counts cells, and compares it with the same threshold at L185-189.
- `packages/sheets/src/config/config.ts` L23-38 and L64-70: the threshold is documented as a number of cells; defaults at L73-76 (6,000 cells, batches of 3,000).
- `packages/sheets-ui/src/commands/commands/remove-sheet-confirm.command.ts` L56-70: the confirmation dialog decides the large-sheet text with the same `countCells()`.
- `packages/sheets/src/commands/commands/__tests__/util-extra.spec.ts` L83-90: the existing test puts each value in a different row, so it passes whether rows or cells are counted.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0. Affected packages: `@univerjs/sheets` (and `@univerjs/sheets-ui` for the dialog). The code is unchanged on `dev` and in `v1.0.2` (checked on 2026-09-28).
- Browsers: Chromium 153.0.8010.12 and WebKit 26.6 bundled with Playwright 1.63.0, Google Chrome 153.0.8010.53; all headless, driven by Playwright. Also reproduced without a browser: Node.js 24.21.0.
- OS: macOS 26.5.1 (Apple M4 Pro) for the browser runs; macOS 27.0 (arm64) for the Node.js run.

### Suggested fix

- Count cells in `util.ts`:

  ```ts
  export function countCells(cellMatrix: ObjectMatrix<unknown>): number {
      let count = 0;
      cellMatrix.forValue(() => {
          count++;
      });
      return count;
  }
  ```

  (or share one cell counter with `copy-worksheet.command.ts`), and add a test with several cells in one row. The confirmation dialog then becomes consistent as well, since it uses the same function.
- Document in `ILargeSheetOperationConfig` that removing a large sheet clears the undo/redo history of the whole workbook, not only the removal, and consider saying so in the confirmation dialog. If feasible, keep earlier undo steps that do not touch the removed sheet instead of clearing everything.
