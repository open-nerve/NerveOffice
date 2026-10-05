// 捕获时机复核的样本（M3-P4 设计 §3.15）写库用的快照：在新建表格的模板上换进样本的工作表（定义在
// apps/web/src/editor/testing/capture-samples.ts，页面自检按同一份定义核对）。写库时换上文档自己的 unitId（与新建的模板相同，database.ts 的 SnapshotFor）。
// - formulaSampleFor：M0-P3 V07 的公式场景（依赖链、聚合、跨表、SUMPRODUCT、易变函数），公式不带缓存值、打开时算；
// - autosaveFormulaSampleFor：同样的五类场景缩小的一份（US-M3-03 的 E2E，M3-P4 S6）——那些用例 × 两种公式模式 × 四个浏览器，
//   每条只改几处、看自动保存存下的值，不要自检那样的计算量；核对时把同一个规模交给 verifyFormulaSnapshot；
// - autosaveStopSampleFor：再加一张 520 个带缓存值的 SUMPRODUCT 的"重"表（"计算进行中被 stop"的那一条用）；
// - bigSheetFor：5 万行的一列文字（自动行高的迟到、大表复制）
import type { FormulaSample, SampleSheet } from '../../../apps/web/src/editor/testing/capture-samples.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { bigSheet, FORMULA_SAMPLE, formulaSampleSheets } from '../../../apps/web/src/editor/testing/capture-samples.ts'

/**
 * US-M3-03 的 E2E 用的公式样本：链 50 层、聚合 2,000 行与 4 个聚合公式、跨表 3 个、SUMPRODUCT 40 个（阈值步长 25，仍覆盖 0–975）、
 * 易变函数 5 个，没有"重"表——共 101 个公式。改聚合!B1 牵动 51 个（多于主线程模式每次让出之前算的 20 个：一轮至少让出一次）
 */
export const AUTOSAVE_FORMULA_SAMPLE: FormulaSample = {
  ...FORMULA_SAMPLE,
  chain: { ...FORMULA_SAMPLE.chain, length: 50 },
  aggregate: { ...FORMULA_SAMPLE.aggregate, rows: 2_000 },
  slow: { ...FORMULA_SAMPLE.slow, count: 40, step: 25 },
  heavy: { ...FORMULA_SAMPLE.heavy, rows: 0, count: 0 },
}

interface TemplateWorkbook {
  sheetOrder: string[]
  sheets: Record<string, Record<string, unknown>>
}

/** 模板换上 unitId，工作表换成给定的几张（每张沿用模板工作表的其余字段：冻结、默认行高列宽等） */
function workbookWith(unitId: string, sheets: readonly SampleSheet[]): string {
  const workbook = JSON.parse(sheetSnapshotFor(unitId)) as TemplateWorkbook
  const template = workbook.sheets['sheet-1']
  if (template === undefined)
    throw new Error('模板里没有 sheet-1')
  workbook.sheets = Object.fromEntries(sheets.map(sheet => [sheet.id, { ...template, id: sheet.id, name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount, cellData: sheet.cellData }]))
  workbook.sheetOrder = sheets.map(sheet => sheet.id)
  return JSON.stringify(workbook)
}

/** 公式样本的快照：五张表，公式都不带缓存值 */
export function formulaSampleFor(unitId: string): string {
  return workbookWith(unitId, formulaSampleSheets())
}

/**
 * "计算进行中被 stop"用的样本：AUTOSAVE_FORMULA_SAMPLE 再加"重"表——A 列 2,000 个数、C 列 520 个 SUMPRODUCT（带缓存值，打开时不算）。
 * 改重!A1 牵动 520 个公式：引擎每算 intervalCount 个公式才看一次 stop（engine-formula 的 calculate-formula.service.ts，Worker 里是默认的 500，
 * 主线程模式是 20，第一个公式之前都看一次），多于 500 个，Worker 里的一轮在算完之前至少还看一次，stop 在那之前到达就停得下来
 */
export const AUTOSAVE_STOP_SAMPLE: FormulaSample = {
  ...AUTOSAVE_FORMULA_SAMPLE,
  heavy: { ...FORMULA_SAMPLE.heavy, rows: 2_000, count: 520, step: 2 },
}

/** "计算进行中被 stop"用的样本的快照（AUTOSAVE_STOP_SAMPLE）：六张表，"重"表的公式带缓存值 */
export function autosaveStopSampleFor(unitId: string): string {
  return workbookWith(unitId, formulaSampleSheets(AUTOSAVE_STOP_SAMPLE))
}

/** US-M3-03 的 E2E 用的公式样本的快照（AUTOSAVE_FORMULA_SAMPLE）：五张表，公式都不带缓存值 */
export function autosaveFormulaSampleFor(unitId: string): string {
  return workbookWith(unitId, formulaSampleSheets(AUTOSAVE_FORMULA_SAMPLE))
}

/** 大表的快照：一张 5 万行的表 */
export function bigSheetFor(unitId: string): string {
  return workbookWith(unitId, [bigSheet()])
}
