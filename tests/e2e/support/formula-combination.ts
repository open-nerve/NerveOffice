import type { Workbook } from './sheet.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { expect } from './fixtures.ts'
import { cellOf, resourceOf } from './sheet.ts'

interface SampleSheet {
  id: string
  name: string
  cellData: Record<string, Record<string, { v?: unknown, f?: string, t?: number }>>
}

interface SampleBook {
  id: string
  sheetOrder: string[]
  sheets: Record<string, SampleSheet>
  resources: { name: string, data: string }[]
}

const SUMMARY = 'm5-formula-summary'
const NAME = '当前数量'
const NOTE = 'M5 公式组合的备注'

function formulas(sourceName: string) {
  const source = `'${sourceName.replaceAll('\'', '\'\'')}'!`
  return [
    `=SUM(${source}A1:A2)`,
    `=AVERAGE(${source}A1:A2)`,
    `=SUM(${NAME})`,
    `=${source}D1&"-"&SUM(${NAME})`,
    `=${source}A1`,
  ]
}

/** 保留调用方的 A1/A2/B1 等原断言位置；新增第二表、名称、规则与备注。 */
export function withFormulaCombination(text: string, stale = false): string {
  const book = JSON.parse(text) as SampleBook
  const firstId = book.sheetOrder[0]
  const first = firstId === undefined ? undefined : book.sheets[firstId]
  if (first === undefined || firstId === undefined || book.sheetOrder.length !== 1 || book.sheets[SUMMARY] !== undefined)
    throw new Error('公式组合夹具的第一表缺失或汇总表已存在')
  first.cellData['0'] = { ...first.cellData['0'], 3: { v: '组合', t: 1 } }
  const summary = {
    ...structuredClone(first),
    id: SUMMARY,
    name: '公式汇总',
    cellData: Object.fromEntries(formulas(first.name).map((f, row) => [
      row,
      { 0: { f, ...(stale ? { v: 999, t: 2 } : {}) } },
    ])),
  }
  book.sheets[SUMMARY] = summary
  book.sheetOrder.push(SUMMARY)
  const range = { startRow: 0, endRow: 0, startColumn: 4, endColumn: 4 }
  const resources: Record<string, unknown> = {
    SHEET_DEFINED_NAME_PLUGIN: {
      m5_quantity: { id: 'm5_quantity', name: NAME, formulaOrRefString: `'${first.name}'!$A$1:$A$2`, localSheetId: 'AllDefaultWorkbook' },
    },
    SHEET_NOTE_PLUGIN: {
      [firstId]: { 0: { 4: { id: 'm5_note', note: NOTE, width: 160, height: 60, row: 0, col: 4 } } },
    },
    SHEET_DATA_VALIDATION_PLUGIN: {
      [firstId]: [{ uid: 'm5_validation', type: 'decimal', operator: 'greaterThan', formula1: '0', ranges: [range] }],
    },
    SHEET_CONDITIONAL_FORMATTING_PLUGIN: {
      [firstId]: [{
        cfId: 'm5_condition',
        ranges: [range],
        stopIfTrue: false,
        rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 0, style: { bg: { rgb: 'rgb(253,230,138)' } } },
      }],
    },
  }
  for (const resource of book.resources) {
    if (Object.hasOwn(resources, resource.name)) {
      if (resource.data !== '' && resource.data !== '{}')
        throw new Error(`组合起点的资源应为空：${resource.name}`)
      resource.data = JSON.stringify(resources[resource.name])
    }
  }
  return JSON.stringify(book)
}

/** 默认合法的非空数值避免刚打开时 AVERAGE 的空范围错误；正式输入仍是用户动作。 */
export function formulaCombinationFor(unitId: string): string {
  const book = JSON.parse(sheetSnapshotFor(unitId)) as SampleBook
  book.sheets[book.sheetOrder[0]!]!.cellData = { 0: { 0: { v: 1, t: 2 } } }
  return withFormulaCombination(JSON.stringify(book))
}

/** 期望只从用例给定的两个输入算出，不能读取 SDK 结果来产生期望。 */
export function expectFormulaCombination(book: Workbook, first: number, second?: number): void {
  const firstId = book.sheetOrder[0]!
  const source = book.sheets[firstId]!
  const sum = first + (second ?? 0)
  const values = [sum, sum / (second === undefined ? 1 : 2), sum, `组合-${sum}`, first]
  for (const [row, f] of formulas(source.name).entries())
    expect(cellOf(book, `A${row + 1}`, SUMMARY)).toMatchObject({ f, v: values[row] })
  expect(resourceOf(book, 'SHEET_DEFINED_NAME_PLUGIN')).toMatchObject({
    m5_quantity: { id: 'm5_quantity', name: NAME, formulaOrRefString: `'${source.name}'!$A$1:$A$2`, localSheetId: 'AllDefaultWorkbook' },
  })
  expect(resourceOf(book, 'SHEET_NOTE_PLUGIN')).toMatchObject({
    [firstId]: { 0: { 4: { id: 'm5_note', note: NOTE, width: 160, height: 60, row: 0, col: 4 } } },
  })
  expect(resourceOf(book, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({
    [firstId]: [{ uid: 'm5_validation', type: 'decimal', operator: 'greaterThan', formula1: '0', ranges: [{ startRow: 0, endRow: 0, startColumn: 4, endColumn: 4 }] }],
  })
  expect(resourceOf(book, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN')).toMatchObject({
    [firstId]: [{ cfId: 'm5_condition', stopIfTrue: false, ranges: [{ startRow: 0, endRow: 0, startColumn: 4, endColumn: 4 }], rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 0, style: { bg: { rgb: 'rgb(253,230,138)' } } } }],
  })
}
