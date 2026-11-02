import type { IWorkbookData } from '@univerjs/core'
import type { CsvTable } from '../../shared/csv/index.ts'
import { SHEET_TEMPLATE, sheetSnapshotFor, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { CellValueType } from '@univerjs/core'
import { describe, expect, it, vi } from 'vitest'
import { CsvError } from '../../shared/csv/index.ts'
import { CsvOperationError } from './csv-operation-error.ts'
import { csvFixture } from './csv.test-support.ts'
import { assertNewCsvDocument } from './new-csv-document.ts'
import { createSheetCsv } from './sheet-csv.ts'

vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

function table(rows: string[][]): CsvTable {
  return { rows, rowCount: rows.length, columnCount: rows[0]?.length ?? 0 }
}

describe('CSV 新建前候选容量检查', () => {
  it('允许文本/普通数字，实际 SDK 单次插表沿相同类型转换，模板不被改动', async () => {
    const original = JSON.stringify(SHEET_TEMPLATE)
    const input = table([['001', '=1+1', '-12.5', '2026-11-01']])
    expect(() => assertNewCsvDocument(input)).not.toThrow()
    const id = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
    const h = csvFixture(JSON.parse(sheetSnapshotFor(id)) as IWorkbookData)
    try {
      const csv = createSheetCsv({
        univer: h.univer,
        univerAPI: h.api,
        workbook: h.workbook,
        canRead: () => true,
        canWrite: () => true,
        formulasSettled: () => true,
        newId: () => id,
        reportError: (error) => { throw error },
      })
      const sheetId = csv.insert(input)
      expect(h.workbook.save().sheets[sheetId]?.cellData?.[0]).toEqual({ 0: { v: '001', t: CellValueType.STRING }, 1: { v: '=1+1', t: CellValueType.STRING }, 2: { v: -12.5, t: CellValueType.NUMBER }, 3: { v: '2026-11-01', t: CellValueType.STRING } })
      expect(new TextEncoder().encode(JSON.stringify(h.workbook.save())).byteLength).toBeLessThan(SNAPSHOT_MAX_RAW_BYTES)
      expect(h.state().history.undos).toBe(1)
    }
    finally { await h.dispose() }
    expect(JSON.stringify(SHEET_TEMPLATE)).toBe(original)
  })

  it('CSV 输入不足 1 MiB，但 JSON 转义后超过 5 MiB，创建前即拒绝', () => {
    const input = table(Array.from({ length: 30 }, () => ['\u0001'.repeat(32_767)]))
    expect(new TextEncoder().encode(input.rows.map(row => row[0]).join('\n')).byteLength).toBeLessThan(1024 * 1024)
    expect(() => assertNewCsvDocument(input)).toThrow(new CsvOperationError('capacity'))
  })

  it('十万格在既定行列、快照字节和复杂度预算内可通过，不引入更小的暗限', () => {
    const input = table(Array.from({ length: 1000 }, () => Array.from<string>({ length: 100 }).fill('x')))
    expect(() => assertNewCsvDocument(input)).not.toThrow()
  })

  it('内部交接的非法矩阵不能跳过字段和形状检查', () => {
    expect(() => assertNewCsvDocument(table([['\u0000']]))).toThrow(CsvError)
    expect(() => assertNewCsvDocument({ rows: [['a']], rowCount: 2, columnCount: 1 })).toThrow(CsvError)
    expect(() => assertNewCsvDocument(table([['a'.repeat(32_768)]]))).toThrow(CsvError)
  })
})
