import type { IWorkbookData } from '@univerjs/core'
import type { CsvTable } from '../../shared/csv/index.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { CSV_SHEET_COMMAND } from '../internal-api/index.ts'
import { assertCsvSnapshot } from './csv-snapshot.ts'
import { csvWorksheet } from './csv-worksheet.ts'

// 实际文档与新表 id 都是 36 字符 UUID；使用固定占位仅作纯候选计量，不创建 SDK 实例或持久文档。
const ID = '00000000-0000-4000-8000-000000000000'

/** 创建前检查已知空白模板的完整候选；实际插入仍由 S2 检查当时的原工作簿。 */
export function assertNewCsvDocument(table: CsvTable): void {
  const original = JSON.parse(sheetSnapshotFor(ID)) as IWorkbookData
  const sheet = CSV_SHEET_COMMAND.prepare(csvWorksheet(table, { id: ID, name: 'CSV导入' }))
  assertCsvSnapshot({ ...original, sheetOrder: [...original.sheetOrder, ID], sheets: { ...original.sheets, [ID]: sheet } })
}
