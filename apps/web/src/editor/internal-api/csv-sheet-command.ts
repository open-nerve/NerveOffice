import type { IWorksheetData } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { mergeWorksheetSnapshotWithDefault } from '@univerjs/core'
import { InsertSheetCommand } from '@univerjs/sheets'

/** 固定 SDK 的完整插表命令：沿原权限/历史通道，不逐格写入，也不使用忽略返回值的 Facade.insertSheet。 */
export const CSV_SHEET_COMMAND = Object.freeze({
  prepare: (sheet: IWorksheetData): IWorksheetData => mergeWorksheetSnapshotWithDefault(sheet),
  insert: (api: FUniver, unitId: string, sheet: IWorksheetData, index: number): boolean => api.syncExecuteCommand(InsertSheetCommand.id, { unitId, sheet, index }),
})
