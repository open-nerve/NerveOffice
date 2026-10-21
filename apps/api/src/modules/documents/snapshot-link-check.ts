import type { CellLinkRule, SnapshotLinkLocation } from '@nerve-office/contracts'
import { checkCellLinks, isSnapshotLocationIdentifier, SNAPSHOT_LINK_LOCATION_LIMIT, SNAPSHOT_POSITION_MAX } from '@nerve-office/contracts'

export type WorkbookLinkCheck = { readonly ok: true } | {
  readonly ok: false
  readonly rule: CellLinkRule
  readonly linkLocations: readonly SnapshotLinkLocation[]
}

/** 与原扫描一样接受对象和数组容器，逐项读取，避免为整张表复制键值对数组。 */
function* entriesOf(value: unknown): Generator<readonly [string, unknown]> {
  if (typeof value !== 'object' || value === null)
    return
  const object = value as Readonly<Record<string, unknown>>
  for (const key in object) {
    if (Object.hasOwn(object, key))
      yield [key, object[key]]
  }
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coordinate(key: string): number | undefined {
  const number = Number(key)
  return Number.isInteger(number) && number >= 0 && number <= SNAPSHOT_POSITION_MAX && String(number) === key ? number : undefined
}

function locationOf(sheetId: string, rowKey: string, columnKey: string): SnapshotLinkLocation {
  if (!isSnapshotLocationIdentifier(sheetId))
    return { kind: 'workbook' }
  const row = coordinate(rowKey)
  const column = coordinate(columnKey)
  return row === undefined || column === undefined ? { kind: 'sheet', sheetId } : { kind: 'cell', sheetId, row, column }
}

/**
 * 只检查真实 sheets/cellData 路径，不限 sheetOrder。首个失败仍由原 checkCellLinks 决定；
 * 额外收集同一规则的至多五个位置，不能把更晚的规则或任意嵌套路径变成错误位置。
 */
export function checkWorkbookLinks(snapshot: Readonly<Record<string, unknown>>): WorkbookLinkCheck {
  let rule: CellLinkRule | undefined
  const linkLocations: SnapshotLinkLocation[] = []
  const seen = new Set<string>()
  for (const [sheetId, sheet] of entriesOf(snapshot.sheets)) {
    if (!record(sheet))
      continue
    for (const [rowKey, row] of entriesOf(sheet.cellData)) {
      for (const [columnKey, cell] of entriesOf(row)) {
        if (!record(cell))
          continue
        const check = checkCellLinks(cell.p)
        if (check.ok)
          continue
        rule ??= check.rule
        if (check.rule !== rule)
          continue
        const location = locationOf(sheetId, rowKey, columnKey)
        const key = JSON.stringify(location)
        if (seen.has(key))
          continue
        seen.add(key)
        linkLocations.push(location)
        if (linkLocations.length === SNAPSHOT_LINK_LOCATION_LIMIT)
          return { ok: false, rule, linkLocations }
      }
    }
  }
  return rule === undefined ? { ok: true } : { ok: false, rule, linkLocations }
}
