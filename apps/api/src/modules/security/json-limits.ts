/** JSON 请求体的嵌套深度与元素数量上限（规范 §4、00 号计划书 §11.2）。快照在 P4 另有自己的校验。 */
export const JSON_MAX_DEPTH = 32
/** 元素数量：对象的键加数组的项。 */
export const JSON_MAX_ENTRIES = 10_000

export interface JsonLimits {
  maxDepth: number
  maxEntries: number
}

export type JsonLimitViolation = 'depth' | 'entries'

/** 逐层遍历（不用递归，嵌套再深也不会爆栈），超出任何一项就停下。最外层的对象或数组算第 1 层。 */
export function checkJsonLimits(value: unknown, limits: JsonLimits = { maxDepth: JSON_MAX_DEPTH, maxEntries: JSON_MAX_ENTRIES }): JsonLimitViolation | undefined {
  let entries = 0
  const pending: { value: unknown, depth: number }[] = [{ value, depth: 1 }]
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (typeof item.value !== 'object' || item.value === null)
      continue
    if (item.depth > limits.maxDepth)
      return 'depth'
    const children: unknown[] = Array.isArray(item.value) ? item.value : Object.values(item.value)
    entries += children.length
    if (entries > limits.maxEntries)
      return 'entries'
    for (const child of children)
      pending.push({ value: child, depth: item.depth + 1 })
  }
  return undefined
}
