import type { SnapshotImageLocation, SnapshotLinkLocation } from '@nerve-office/contracts'
import { snapshotInvalidDetailsSchema } from '@nerve-office/contracts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'

export type SheetName = (sheetId: string) => string | undefined

/** 保存与另存副本共用同一份宽松错误详情解读。 */
export function snapshotProblem(details: unknown, sheetName?: SheetName): string {
  const parsed = snapshotInvalidDetailsSchema.safeParse(details ?? {})
  const rule = parsed.success ? parsed.data.rule : undefined
  const base = editorMessages.snapshotInvalid(rule)
  const locations = parsed.success ? parsed.data.imageLocations ?? parsed.data.linkLocations : undefined
  if (locations === undefined || locations.length === 0)
    return base
  return editorMessages.snapshotLocations(base, [...new Set(locations.map(location => describeLocation(location, sheetName)))].join('；'))
}

function cellAddress(row: number, column: number): string {
  let letters = ''
  for (let current = column + 1; current > 0; current = Math.floor((current - 1) / 26))
    letters = String.fromCharCode(65 + (current - 1) % 26) + letters
  return `${letters}${row + 1}`
}

function describeLocation(location: SnapshotImageLocation | SnapshotLinkLocation, sheetName: SheetName | undefined): string {
  if (location.kind === 'workbook')
    return editorMessages.snapshotLocation.workbook
  if (location.kind === 'resource')
    return editorMessages.snapshotLocation.resource
  // 名称来自当前实例；服务端的 id 只作查找键，不显示。重建中的查询失败同样回退。
  let name: string | undefined
  try {
    name = sheetName?.(location.sheetId)
  }
  catch {
    name = undefined
  }
  const bounded = typeof name !== 'string' || name.trim() === '' ? undefined : name.length <= 120 ? name : `${name.slice(0, 120)}…`
  const sheet = editorMessages.snapshotLocation.sheet(bounded)
  if (location.kind === 'sheet')
    return sheet
  const address = location.row === undefined || location.column === undefined ? undefined : cellAddress(location.row, location.column)
  return location.kind === 'cell'
    ? editorMessages.snapshotLocation.cell(sheet, address ?? '')
    : editorMessages.snapshotLocation.drawing(sheet, address)
}
