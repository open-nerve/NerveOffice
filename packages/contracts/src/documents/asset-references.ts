import { isPlatformAssetAddress } from './asset-address.ts'

const PREFIX = '/api/assets/'
// 引号分开公式的地址字面量；空白分开文字中的独立地址。括号只可包在整个词的两端，
// 不能把 https://[::1]/api/assets/… 或外部 URL 参数里的 (/api/assets/…) 截成本站引用。
const WORDS = /[^\s"'`]+/gu
const OPENERS = new Set(['(', '[', '{', '<'])
const CLOSERS = new Set([')', ']', '}', '>'])

/**
 * 去掉词首连续的 ([{< 与词尾连续的 )]}>。用下标线性扫描：带 `$` 的可回溯正则在“长串结尾包裹符后接普通字符”上
 * 会二次回溯，任意用户写入的长字符串就能占满快照检查池（M5R-I-04）。
 */
function stripWrappers(word: string): string {
  let start = 0
  let end = word.length
  while (start < end && OPENERS.has(word.charAt(start)))
    start += 1
  while (end > start && CLOSERS.has(word.charAt(end - 1)))
    end -= 1
  return word.slice(start, end)
}

/** 已解析字符串值里的规范相对地址；不解码、不执行公式、不把非规范 URL 截成地址。 */
export function extractAssetIds(value: string): readonly string[] {
  // 规范地址必然含有前缀；绝大多数正文字符串不含它，直接跳过分词
  if (!value.includes(PREFIX))
    return []
  const ids = new Set<string>()
  for (const match of value.matchAll(WORDS)) {
    const address = stripWrappers(match[0])
    if (isPlatformAssetAddress(address, ''))
      ids.add(address.slice(PREFIX.length))
  }
  return [...ids].sort()
}
