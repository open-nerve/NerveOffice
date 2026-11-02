# P5-S2 CSV 编辑器适配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 同一 P5 worktree 内完成，S2 全绿后中文提交；后续 Phase 原门禁保持。

**Goal:** 提供不泄露 SDK 对象的 CSV 读写接口，证明安全类型、最终快照预算、单次插表与撤销。

**Architecture:** S1 的共享编解码只处理格式；适配层构造显式单元格和工作表，再对最新完整候选快照预检，通过一个受控 SDK command 插入。原服务端纯 JSON 复杂度计量下沉 contracts 共用，保留服务端原出口和全部规则，不增加 API/存储协议。

**Tech Stack:** 固定 Univer 1.0.1、现有 TypeScript/Vitest；不升级或添加依赖。

**Spec:** `docs/v0.1/M5-表格能力与资源/05-P5-CSV.md` §3–4.1；S1 审查见 `reviews/P5-S1-CSV编解码复核.md`。

## Global Constraints

- CSV 上限为文件 5 MiB、字段 32,767 UTF-16 code unit、50,000 行/1,024 列/矩形 100,000 格；最终快照 `SNAPSHOT_MAX_RAW_BYTES=5 MiB`，嵌套 64、外层和资源 data 合计元素 1,500,000，沿用服务端原值。
- 纯函数移到 contracts 只共享已有检查，不削弱或另造服务端规则。保留 `snapshot-checks.ts` 的已有导出，现有用例不改断言。
- 数值推断必须值等价；长编号、日期、指数、空白、公式形态、下溢或精度损失均保持显式文本；公式字段始终缺省。
- SDK 只在 editor；命令 id、默认工作表合并等内部协议集中封装登记，不能把 SDK 对象交给 features/shared。
- 先校验全部候选，再单次修改。取消及 UI 会话协调由 S3 承担；本层仍核对可读/可写、实例有效和公式就绪。
- 测试都经资源运行器，重型串行，保留小型必要报告，临时资料及时清理；主目录始终 main。

## Review Focus

1. 极小但非零十进制下溢，以及次正规数精度损失不能转成错误数字；Task 1 用独立字面量覆盖。
2. 原工作簿快照已近容量，资源 data 内还藏元素数；Task 1 的完整候选检查和 Task 2 不变断言覆盖。
3. 仅格式的远端单元格不能制造巨型 CSV 矩形；隐藏表和图片/插件地址不应输出；Task 2 真实 SDK 样本覆盖。
4. SDK 插表返回 false 时不能因 Facade 后续激活失败而误报已导入；Task 2 直接使用登记的单次 command，并核对拒绝与真实撤销。
5. 当前实例销毁/阅读态/公式未就绪时，旧操作不得继续读写；Tasks 2/3 验证。完整页面会话竞态留给 S3，不提前宣称覆盖。

### Task 1: 类型转换与候选快照检查

**Files:** 创建 `apps/web/src/editor/csv/csv-worksheet.ts`、`csv-worksheet.test.ts`、`csv-snapshot.ts`、`csv-snapshot.test.ts`、`csv-operation-error.ts`；创建 `packages/contracts/src/documents/json-complexity.ts`，修改 contracts 的 `index.ts` 和服务端 `apps/api/src/modules/documents/snapshot-checks.ts` 以保留旧出口。

**Interfaces:**
- Consumes: S1 `CsvTable`/`CSV_LIMITS`/`CsvError`，现有快照常量和 `SHEET_TEMPLATE`。
- Produces: `csvCell(text: string): ICellData`（只在 editor 内使用）；`csvWorksheet(table: CsvTable, identity: { readonly id: string, readonly name: string }): IWorksheetData`。
- Produces: `assertCsvSnapshot(snapshot: IWorkbookData): void`，只验证最终 JSON 字节、深度与累计元素；超出抛 `CsvOperationError('capacity')`。
- Produces: `CsvOperationError` 的 reason 为 `unavailable | read-only | sheet-missing | capacity | formula-pending | insert-failed`。
- 共用原函数：`measureJsonText(text: string, depth: number, count: EntryCount): JsonLimitRule | undefined`，以及 `SNAPSHOT_MAX_ENTRIES`、`RESOURCE_DATA_DEPTH`；算法与值不改。原服务端继续自行处理结构、JSON 合法性、资源、链接、身份等规则。

- [x] 写 RED：`-2` → `{v:-2,t:2}`，`0.125` → 数字；`001`/`2026-11-01`/`=1+1`/`-2+3`/`+1`/16 位编号/指数/空白 → `{v:原文,t:1}`，无 f/si；非零下溢与次正规数不等价保留文本；普通 emoji 保留。
- [x] 写 RED：构造表的 rows/columns/cells/field 与 CsvTable 统计不符拒绝；原表对象不改；最终快照恰好字节上限通过、多一拒绝，资源 data 深度及累计元素受原预算约束。
- [x] Run: `python3 tools/test-resources/run.py unit -- pnpm exec vitest run --project unit-web src/editor/csv/csv-worksheet.test.ts src/editor/csv/csv-snapshot.test.ts --maxWorkers=2`。Expected: 未实现能力 RED。
- [x] 数字判定采用普通十进制语法、有效位数和规范化十进制值对比（输入与 Number 的最短字符串按系数/指数比较），不使用浮点容差。工作表从现有默认形状构造新数据，逐格显式类型；不设置公式。
- [x] 将既有 JSON 复杂度计量原样移到 contracts，API 保留原导出；候选检查同时计外层和每份非空资源 data。
- [x] Run: 上述定向命令，再受管运行原 `apps/api/src/modules/documents/snapshot-checks.test.ts`、`snapshot-inspection.test.ts`。Expected: 新旧全部 GREEN；不改原断言。

### Task 2: 单次插表及显示值读取

**Files:** 创建 `apps/web/src/editor/csv/sheet-csv.ts`、`sheet-csv.test.ts`、必要的 `csv.test-support.ts`；在 `editor/internal-api/` 增加 `csv-sheet-command.ts`、`csv-array-cells.ts` 并经 `index.ts`/`registry.ts` 登记，补 ADR-010；只为确属公开的 CellValueType 补 `eslint.config.ts` 白名单。

**Interfaces:**
- Consumes: Task 1 的构表/完整候选检查；`FWorkbook` 与 `FUniver` 仅在 editor 内。
- Produces: `CsvSheetSummary { readonly id: string, readonly name: string, readonly active: boolean }`。
- Produces: `SheetCsv { sheets(): readonly CsvSheetSummary[], read(sheetId: string): readonly (readonly CsvExportCell[])[], insert(table: CsvTable): string }`；返回的 string 为新增 sheetId。
- Produces: `createSheetCsv(options: { univer: Univer, workbook: FWorkbook, univerAPI: FUniver, canRead: () => boolean, canWrite: () => boolean, formulasSettled: () => boolean, newId: () => string, reportError: (error: unknown) => void }): SheetCsv`。
- 内部封装 `CSV_SHEET_COMMAND` 负责 SDK 默认形状合并和同步 InsertSheetCommand；命令只插入，不捆绑 Facade 的“插入后按数组下标激活”。激活作为成功插入后的视图操作，失败不能冒称正文没写入。

- [x] 写 RED：真实 SDK core + 既有 data plugins，插入含文本/数字样本后旧表和六类资源不变，onChange 可观察，一次 undo 恢复、一轮 redo 重现；只读/失效/命令拒绝/超限时原快照及 undo 状态不变。
- [x] 写 RED：读指定可见表，返回原数值类型与显示结果（千分位、日期、布尔、富文本、公式缓存），无 f/source/资源；空表为单空格；只格式远端格忽略；中间空格与非 A1 起始内容保留；真实只读前后快照字节相同。公式未就绪、隐藏/不存在的表拒绝。
- [x] Run: `python3 tools/test-resources/run.py unit -- pnpm exec vitest run --project unit-web src/editor/csv/sheet-csv.test.ts --maxWorkers=2`。Expected: RED。
- [x] 追加独审 I1：只读枚举固定 FormulaDataModel 中当前文档/表的实际数组结果坐标与数值类型，以缓存格补范围；保留原富文本优先、nullish→0，空字符串结果占格，已清除缓存和意图范围不扩大导出。真实缓存 mutation 的 7 条对照及原回归已通过；真实计算故事归 S5。
- [x] 根据最新 `workbook.save()` 的稀疏 cellData 识别实际内容范围，先限制矩形再调用公开 `getDisplayValues()`；数字 kind 由原值决定，保护交 S1。显示读取不能当保存捕获。
- [x] 插表生成无冲突身份和名称、建立完整候选、预检、同步一次 command；成功后尝试切到新表。全部 SDK 协议集中登记，禁止逐格写入与失败后覆盖原快照。
- [x] 同命令与原 internal-api registry 测试 GREEN；核对 command 拒绝没有应用部分内容。

### Task 3: 正式 SheetEditor 生命周期接线

**Files:** 修改 `apps/web/src/editor/sheet-editor.ts`、`index.ts`、`sheet-editor.test.ts` 及必要的已有测试工厂。

**Interfaces:**
- Consumes: Task 2 的 `createSheetCsv`。
- Produces: `SheetEditor.csv: SheetCsv`；公开出口只导出类型与 CsvOperationError，SDK 对象不外泄。

- [x] 写 RED：创建后的 read/edit 实例具有正确能力，read 允许导出但不能插入；dispose 后捕获的旧 csv 对象拒绝读写；公式正在计算时 read 拒绝，收齐后恢复；真实变更检测观察插表。
- [x] Run: `python3 tools/test-resources/run.py unit -- pnpm exec vitest run --project unit-web src/editor/sheet-editor.test.ts src/editor/csv --maxWorkers=2`。Expected: 新接线 RED。
- [x] 接入实例的 disposed/access/change tracker，只暴露轻量接口；修正测试工厂以遵守新增正式类型，不把测试专用方法放进产品。
- [x] 同命令 GREEN；定向 lint、全仓 typecheck、受管全仓单元回归串行通过，更新 ADR/复核记录后中文提交。Expected: S2 接口可供 S3 使用；用户入口仍未开放，P5 未完成。

## 自审与已知边界

S2 复用已有纯计量函数而不是把服务端模块导入 web，没有新增跨模块调用或修改协议；这是已批准 CSV 容量预检所需的共享实现。主线程/Worker 真公式进度、真实页面保存重开和全部浏览器兼容性还要在 S3/S5 验证；本 Step SDK 数据插件测试不冒充浏览器证据。后续如果实际 SDK 默认形状或插件资源改变使候选不能准确预检，先调查原件，不按猜测增加容量豁免。
