// 快照里 JSON 值的几个基本判断（profile-resources.ts、link-address.ts、content-canonical.ts 共用；不经 contracts 的入口转出）

/** JSON 的对象：不是 null、不是数组的对象（JSON.parse 的结果与 mutation 的参数都是普通对象） */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深层为空的叶子：null、空串（以及只在内存里出现的 undefined）。空对象、空数组按它们的每一项都为空判断 */
export function isEmptyLeaf(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/** 按 UTF-16 码元比较两个字符串（JS 的 < 就是这个顺序）：排序的结果与语言环境无关，各端一致 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
