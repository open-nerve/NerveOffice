import type { SnapshotImageLocation } from '@nerve-office/contracts'
import type { EmbeddedJson } from './snapshot-checks.ts'
import { isPlatformAssetAddress, isSnapshotImageIdentifier, SNAPSHOT_IMAGE_LOCATION_LIMIT, SNAPSHOT_IMAGE_POSITION_MAX } from '@nerve-office/contracts'

type Route = 'workbook' | 'sheets' | 'sheet' | 'cells' | 'row' | 'resources' | 'drawing-resource' | 'drawing-sheet' | 'drawing-data' | 'nested'
interface Context {
  readonly route: Route
  readonly location: SnapshotImageLocation
  readonly sheetId?: string
  readonly row?: number
}
interface Root extends Context { readonly value: unknown }
interface Level extends Context {
  readonly node: object
  readonly keys: readonly string[] | undefined
  readonly length: number
  index: number
}
const WORKBOOK: SnapshotImageLocation = { kind: 'workbook' }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function position(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SNAPSHOT_IMAGE_POSITION_MAX
}
function coordinate(key: string): number | undefined {
  if (!/^(?:0|[1-9]\d{0,9})$/.test(key))
    return undefined
  const value = Number(key)
  return position(value) ? value : undefined
}

/** 身份只来自真实 sheets/data 路径；相同名字的嵌套对象不能伪造该路径。 */
function childContext(parent: Context, key: string, child: object, snapshot: Readonly<Record<string, unknown>>): Context {
  if (parent.route === 'nested')
    return parent
  const fallback: Context = { route: 'nested', location: parent.location }
  const { route, sheetId } = parent
  if (route === 'workbook') {
    if (key === 'sheets' && record(child))
      return { ...fallback, route: 'sheets' }
    if (key === 'resources' && Array.isArray(child))
      return { ...fallback, route: 'resources' }
  }
  if (route === 'resources') {
    const index = coordinate(key)
    if (index !== undefined)
      return { route: 'nested', location: { kind: 'resource', resourceIndex: index } }
  }
  if (route === 'sheets' && isSnapshotImageIdentifier(key) && record(child))
    return { route: 'sheet', sheetId: key, location: { kind: 'sheet', sheetId: key } }
  if (route === 'sheet' && key === 'cellData')
    return { ...fallback, route: 'cells', sheetId }
  if (route === 'cells') {
    const row = coordinate(key)
    if (row !== undefined)
      return { ...fallback, route: 'row', sheetId, row }
  }
  if (route === 'row' && sheetId !== undefined && parent.row !== undefined && record(child)) {
    const column = coordinate(key)
    if (column !== undefined)
      return { route: 'nested', location: { kind: 'cell', sheetId, row: parent.row, column } }
  }
  if (route === 'drawing-resource' && isSnapshotImageIdentifier(key) && record(child) && record(snapshot.sheets) && Object.hasOwn(snapshot.sheets, key))
    return { ...fallback, route: 'drawing-sheet', sheetId: key }
  if (route === 'drawing-sheet' && key === 'data' && record(child))
    return { ...fallback, route: 'drawing-data', sheetId }
  if (route === 'drawing-data' && sheetId !== undefined && isSnapshotImageIdentifier(key) && record(child)
    && child.drawingId === key && child.subUnitId === sheetId && child.unitId === snapshot.id) {
    const location: SnapshotImageLocation = { kind: 'drawing', sheetId, drawingId: key }
    const transform = record(child.sheetTransform) ? child.sheetTransform : undefined
    const from = record(transform?.from) ? transform.from : undefined
    const sheet = record(snapshot.sheets) ? snapshot.sheets[sheetId] : undefined
    if (from !== undefined && position(from.row) && position(from.column) && record(sheet)
      && typeof sheet.rowCount === 'number' && from.row < sheet.rowCount && typeof sheet.columnCount === 'number' && from.column < sheet.columnCount) {
      return { route: 'nested', location: { ...location, row: from.row, column: from.column } }
    }
    return { route: 'nested', location }
  }
  return fallback
}

/** 原有 source 判定不变；深度优先迭代，栈只随已受限的 JSON 深度增长，不分配整条路径。 */
function collect(roots: Iterable<Root>, snapshot: Readonly<Record<string, unknown>>, limit: number): readonly SnapshotImageLocation[] {
  const locations: SnapshotImageLocation[] = []
  const seen = new Set<string>()
  const stack: Level[] = []
  const enter = (value: unknown, context: Context): void => {
    if (typeof value !== 'object' || value === null)
      return
    const keys = Array.isArray(value) ? undefined : Object.keys(value)
    stack.push({ ...context, node: value, keys, length: keys === undefined ? (value as readonly unknown[]).length : keys.length, index: 0 })
  }
  for (const root of roots) {
    enter(root.value, root)
    for (let level = stack.at(-1); level !== undefined; level = stack.at(-1)) {
      if (level.index >= level.length) {
        stack.pop()
        continue
      }
      const key = level.keys?.[level.index] ?? String(level.index)
      level.index += 1
      const child = (level.node as Record<string, unknown>)[key]
      if (key === 'source' && !(typeof child === 'string' && isPlatformAssetAddress(child, ''))) {
        const encoded = JSON.stringify(level.location)
        if (!seen.has(encoded)) {
          seen.add(encoded)
          locations.push(level.location)
          if (locations.length >= limit)
            return locations
        }
      }
      if (typeof child === 'object' && child !== null)
        enter(child, childContext(level, key, child, snapshot))
    }
  }
  return locations
}

/** 复用原预算内已经解析出的资源值，只保留它在 resources 中的索引。 */
export function snapshotImageLocations(snapshot: Readonly<Record<string, unknown>>, embedded: readonly EmbeddedJson[]): readonly SnapshotImageLocation[] {
  function* roots(): Generator<Root> {
    yield { value: snapshot, route: 'workbook', location: WORKBOOK }
    for (const { resourceIndex, value } of embedded) {
      const resource: unknown = Array.isArray(snapshot.resources) ? snapshot.resources[resourceIndex] : undefined
      yield { value, route: record(resource) && resource.name === 'SHEET_DRAWING_PLUGIN' ? 'drawing-resource' : 'nested', location: { kind: 'resource', resourceIndex } }
    }
  }
  return collect(roots(), snapshot, SNAPSHOT_IMAGE_LOCATION_LIMIT)
}

/** 原规则的布尔入口与其回归共用同一个扫描器。生产检查直接取有界位置，不再扫第二次。 */
export function hasForeignImage(roots: readonly unknown[]): boolean {
  return collect(roots.map(value => ({ value, route: 'nested', location: WORKBOOK })), {}, 1).length !== 0
}
