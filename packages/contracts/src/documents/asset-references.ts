import { isPlatformAssetAddress } from './asset-address.ts'

const PREFIX = '/api/assets/'
// 引号分开公式的地址字面量；空白分开文字中的独立地址。括号只可包在整个词的两端，
// 不能把 https://[::1]/api/assets/… 或外部 URL 参数里的 (/api/assets/…) 截成本站引用。
const WORDS = /[^\s"'`]+/gu
const WRAPPERS = /^[([{<]+|[)\]}>]+$/g

/** 已解析字符串值里的规范相对地址；不解码、不执行公式、不把非规范 URL 截成地址。 */
export function extractAssetIds(value: string): readonly string[] {
  const ids = new Set<string>()
  for (const match of value.matchAll(WORDS)) {
    const address = match[0].replace(WRAPPERS, '')
    if (isPlatformAssetAddress(address, ''))
      ids.add(address.slice(PREFIX.length))
  }
  return [...ids].sort()
}
