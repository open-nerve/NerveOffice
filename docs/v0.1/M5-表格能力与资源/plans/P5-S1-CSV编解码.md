# P5-S1 CSV 编解码实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 沿用用户已授权的自主执行，每 Step 通过后提交，不再分小分支。

**Goal:** 在客户端提供可取消、有界且不会静默改变字段的 CSV 编解码。

**Architecture:** 纯格式代码在 `apps/web/src/shared/csv/`，仅暴露字符串矩阵和带显示类型的导出单元格，不引用 SDK。解析一次读入有上限的 UTF-8 字节，在遍历中分批让出事件循环；文件读取和编辑器写入留给后续 Step。

**Tech Stack:** TypeScript、现有 Vitest；不新增依赖。

**Spec:** `docs/v0.1/M5-表格能力与资源/05-P5-CSV.md` §3。

## Global Constraints

- 输入/输出文件最多 5 MiB（包括 BOM），字段最多 32,767 UTF-16 code unit，50,000 行、1,024 列、矩形 100,000 格；错误不回显内容。
- 只支持 UTF-8，导出 BOM/CRLF/双引号；危险文本加 TAB 保护，正常负数保持。
- 主目录保持 main；本 Step 只在唯一 P5 worktree；测试都由 `tools/test-resources/run.py` 运行；必要原始报告保留，临时资源及时清理。
- 本计划不写 SDK、API 或 UI，也不冒称 US-M5-12/13 完成。

## Review Focus

1. 引号内跨行/末尾 CRLF/双写引号组合不能丢字或多一行；Task 1 固定字面量样本。
2. 稀疏长行与后到宽行使矩形膨胀，不能只数非空格；Task 1 验证在矩阵补齐前拒绝。
3. BOM、多字节与坏 UTF-8，不能靠替换字符悄悄修复；Task 1 覆盖字节边界。
4. 数字格式输出也可能是公式形态，不能仅因类型是数字就放行；Task 2 覆盖伪装数值与正常负数。
5. 取消/超限不得留下半份成功数据，转义后大小不能超过预算；Tasks 1/2 覆盖。

### Task 1: 解析器与预算

**Files:** 创建 `apps/web/src/shared/csv/csv-format.ts`、`parse-csv.ts`、`parse-csv.test.ts`；公开出口 `index.ts`。

**Interfaces:**
- Produces: `CsvTable { readonly rows: readonly (readonly string[])[], readonly rowCount: number, readonly columnCount: number }`。
- Produces: `CsvError` 的 `reason` 为 `encoding | syntax | empty | bytes | field | rows | columns | cells | cancelled`；统一内容无关描述。
- Produces: `parseCsv(bytes: Uint8Array, options?: { readonly signal?: AbortSignal }): Promise<CsvTable>`。
- Consumes: 原生 TextDecoder/AbortSignal/setTimeout，无 SDK。

- [x] 写断言：`a,"b,b","c""d"\r\n一,"二\n三",` 得到字面量两行三列；空文件拒绝；引号语法错误拒绝；空行/尾空格不丢；最大值通过而多一拒绝（含矩形膨胀）；坏 UTF-8 拒绝；异步取消不返回部分矩阵。
- [x] Run: `python3 tools/test-resources/run.py unit -- pnpm exec vitest run --project unit-web src/shared/csv/parse-csv.test.ts --maxWorkers=2`。Expected: 新解析能力缺失的 RED（接口初始骨架可明确抛未实现，使断言真实失败）。
- [x] 实现四状态解析（字段开始/普通字段/引号内/闭引号后），边扫描边预算；每 16,384 字符让出并复核取消，结尾只提交实际存在的尾记录。
- [x] 同命令 GREEN；核对清理回执，没有活动临时资料。

### Task 2: 导出与公式文本保护

**Files:** 创建 `apps/web/src/shared/csv/encode-csv.ts`、`encode-csv.test.ts`；更新 `index.ts`。

**Interfaces:**
- Consumes: Task 1 的 `CsvError`/同一预算。
- Produces: `CsvExportCell { readonly text: string, readonly kind: 'text' | 'number' }`；`encodeCsv(rows: readonly (readonly CsvExportCell[])[]): Uint8Array`。

- [x] 写独立断言：BOM/CRLF/双写引号完整字节；文本 `=1+1`、空白/全角/TAB 前缀受保护；数字 `-12.5`/`-1,234.50` 保持；数字类型但显示 `-1+2` 仍保护；中文/日期/空矩阵/超长字段/列格数/转义后字节超限；导出后解析得到预期保护文字。
- [x] Run: `python3 tools/test-resources/run.py unit -- pnpm exec vitest run --project unit-web src/shared/csv/encode-csv.test.ts --maxWorkers=2`。Expected: 新导出能力缺失的 RED。
- [x] 实现字段级保护后双引号转义，按 UTF-8 累加真实输出字节，再一次组装 BOM 输出；使用同一尺寸检查。
- [x] Run: `python3 tools/test-resources/run.py unit -- pnpm exec vitest run --project unit-web src/shared/csv --maxWorkers=2`。Expected: 两组全部 GREEN。
- [x] Step 收口：定向 lint/typecheck、受管 `pnpm test`（串行执行重型命令），更新 P4 事实与当前进度，中文提交本 Step（提交动作在此检查后执行，以 Git 实际记录为准）。Expected: 门禁通过、临时资料已清理，未声明后续 Step 完成。
