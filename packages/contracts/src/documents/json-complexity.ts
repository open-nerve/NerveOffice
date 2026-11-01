// 原服务端快照计量的纯实现；CSV 候选和服务端共享同一预算，不能分别放宽。
import { SNAPSHOT_MAX_DEPTH } from './content.ts'

/**
 * 元素数量的上限（对象的键加数组的项，外层与资源 data 里的 JSON 合计）：只挡最极端的形状。真实形状的 5 MiB 快照约 61 万个
 * （P3 设计前的探索 A §2.5），全是 0 的数组约 260 万、全是空对象的数组约 170 万；60 万个键的大对象挡不住，那要靠子进程的堆上限与并发的上限
 */
export const SNAPSHOT_MAX_ENTRIES = 1_500_000

/**
 * 资源 data 解析出的值嵌在快照里的深度：顶层（第 1 层）→ resources 数组（第 2 层）→ 一项资源 { name, data }（第 3 层）→ data 的位置（第 4 层）。
 * 嵌套按"外层与资源 data 里的 JSON 累加"计（P3 设计 §3.3）：data 里的 JSON 好比直接写在 data 的位置上
 */
export const RESOURCE_DATA_DEPTH = 4

/** 嵌套与数量超出时的规则 */
export type JsonLimitRule = 'depth' | 'entries'

/** 一份快照里各段 JSON 文字合计的元素数（外层与资源 data 累加） */
export interface EntryCount {
  entries: number
}

const QUOTE = 0x22
const BACKSLASH = 0x5C
const COMMA = 0x2C
const OPEN_ARRAY = 0x5B
const CLOSE_ARRAY = 0x5D
const OPEN_OBJECT = 0x7B
const CLOSE_OBJECT = 0x7D

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D
}

/** from 起（跳过空白）紧接着就是右括号：刚打开的对象或数组是空的 */
function closesRightAway(text: string, from: number): boolean {
  for (let index = from; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (!isJsonWhitespace(code))
      return code === CLOSE_ARRAY || code === CLOSE_OBJECT
  }
  return true
}

/**
 * 解析之前按文字数一段 JSON 的嵌套与元素（不解析、不分配，任何文字都不抛出）：
 * - 嵌套：字符串之外的 [ 与 { 打开一层，] 与 } 关上一层；最外层的对象或数组在 depth 层（快照本身是 1，资源的 data 是 RESOURCE_DATA_DEPTH），
 *   任何一层超过 SNAPSHOT_MAX_DEPTH 就是 depth；
 * - 元素（对象的键加数组的项）：字符串之外的逗号各分出一个，每个不空的对象或数组再加一个；与解析之后数出的相同（重复的键多算，只会更严），
 *   累加到 count 上，合计超过 SNAPSHOT_MAX_ENTRIES 就是 entries。
 * 字符串里的引号与反斜杠按 JSON 的转义跳过。不是合法 JSON 的文字数出来的不作数：没超上限的照样交给 JSON.parse，由它报 json
 */
export function measureJsonText(text: string, depth: number, count: EntryCount): JsonLimitRule | undefined {
  let level = depth - 1
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (inString) {
      if (code === BACKSLASH)
        index += 1
      else if (code === QUOTE)
        inString = false
      continue
    }
    if (code === QUOTE) {
      inString = true
    }
    else if (code === OPEN_ARRAY || code === OPEN_OBJECT) {
      level += 1
      if (level > SNAPSHOT_MAX_DEPTH)
        return 'depth'
      if (!closesRightAway(text, index + 1))
        count.entries += 1
    }
    else if (code === CLOSE_ARRAY || code === CLOSE_OBJECT) {
      level -= 1
    }
    else if (code === COMMA) {
      count.entries += 1
    }
    if (count.entries > SNAPSHOT_MAX_ENTRIES)
      return 'entries'
  }
  return undefined
}
