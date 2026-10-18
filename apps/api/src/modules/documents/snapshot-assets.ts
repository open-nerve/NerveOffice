import { extractAssetIds } from '@nerve-office/contracts'

interface Level {
  readonly node: object
  readonly keys: readonly string[] | undefined
  readonly length: number
  index: number
}

/** 只有顶层资源 entry.data 是已解析的 JSON；其他字符串不能再尝试反序列化。 */
function resourceEntries(snapshot: unknown): WeakSet<object> {
  const entries = new WeakSet<object>()
  if (typeof snapshot !== 'object' || snapshot === null || !('resources' in snapshot) || !Array.isArray(snapshot.resources))
    return entries
  for (const entry of snapshot.resources as readonly unknown[]) {
    if (typeof entry === 'object' && entry !== null)
      entries.add(entry)
  }
  return entries
}

/** 只遍历经过预算检查和 JSON.parse 的值；栈大小随深度增长，不把宽数组摊进工作栈。 */
export function snapshotAssetIds(snapshot: unknown, embedded: readonly unknown[]): readonly string[] {
  const entries = resourceEntries(snapshot)
  const ids = new Set<string>()
  const stack: Level[] = []
  const enter = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const id of extractAssetIds(value))
        ids.add(id)
    }
    else if (typeof value === 'object' && value !== null) {
      const keys = Array.isArray(value) ? undefined : Object.keys(value)
      stack.push({ node: value, keys, length: keys === undefined ? (value as readonly unknown[]).length : keys.length, index: 0 })
    }
  }
  for (const root of [snapshot, ...embedded]) {
    enter(root)
    for (let level = stack.at(-1); level !== undefined; level = stack.at(-1)) {
      if (level.index >= level.length) {
        stack.pop()
        continue
      }
      const index = level.index
      level.index += 1
      if (level.keys === undefined) {
        enter((level.node as readonly unknown[])[index])
        continue
      }
      const key = level.keys[index] as string
      if (key !== 'data' || !entries.has(level.node))
        enter((level.node as Record<string, unknown>)[key])
    }
  }
  return [...ids].sort()
}
