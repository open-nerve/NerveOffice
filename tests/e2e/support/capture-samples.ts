// 捕获时机复核的样本（M3-P4 设计 §3.15）写库用的快照：在新建表格的模板上换进样本的工作表（定义在
// apps/web/src/editor/testing/capture-samples.ts，页面自检按同一份定义核对）。写库时换上文档自己的 unitId（与新建的模板相同，database.ts 的 SnapshotFor）。
// - formulaSampleFor：M0-P3 V07 的公式场景（依赖链、聚合、跨表、SUMPRODUCT、易变函数），公式不带缓存值、打开时算；
// - bigSheetFor：5 万行的一列文字（自动行高的迟到、大表复制）
import type { SampleSheet } from '../../../apps/web/src/editor/testing/capture-samples.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { bigSheet, formulaSampleSheets } from '../../../apps/web/src/editor/testing/capture-samples.ts'

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

/** 大表的快照：一张 5 万行的表 */
export function bigSheetFor(unitId: string): string {
  return workbookWith(unitId, [bigSheet()])
}
