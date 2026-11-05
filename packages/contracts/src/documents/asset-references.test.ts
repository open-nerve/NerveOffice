import { describe, expect, it } from 'vitest'
import { isPlatformAssetAddress } from './asset-address.ts'
import { extractAssetIds } from './asset-references.ts'

const A = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const B = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0e'
const url = (id: string): string => `/api/assets/${id}`

describe('解析后字符串中的规范图片地址', () => {
  it.each([
    url(A),
    `=IMAGE("${url(A)}")`,
    `说明 ${url(A)} 后文`,
    `(${url(A)})`,
    `'${url(A)}'`,
    `[${url(A)}]`,
  ])('独立地址或公式字面量：%s', (value) => {
    expect(extractAssetIds(value)).toEqual([A])
  })

  it('同一字符串中完整提取、排重并按码元排序', () => {
    expect(extractAssetIds(`=IF(TRUE,IMAGE("${url(B)}"),IMAGE("${url(A)}")) ${url(A)}`)).toEqual([A, B])
    expect(extractAssetIds(`${url(A)} ${url(B)}`)).toEqual([A, B])
  })

  it.each([
    '',
    '文字',
    A,
    url(A).toUpperCase(),
    `https://example.com${url(A)}`,
    `//host${url(A)}`,
    `https://[::1]${url(A)}`,
    `https://example.com/?next=(${url(A)})`,
    `https://example.com/#(${url(A)})`,
    `${url(A)}?x=1`,
    `${url(A)}#x`,
    `${url(A)}/extra`,
    `${url(A)}a`,
    `${url(A)}-`,
    `${url(A)}%20`,
    `prefix${url(A)}`,
    `/${url(A)}`,
    `\\${url(A)}`,
    `${url(A)}中文`,
    `${url(A)}.png`,
    `${url(A)};x`,
    `/api/assets/${A.slice(0, -1)}`,
    `/api/assets/${A.replace('4a3b', 'zzzz')}`,
    `/api/assets/${A.replace('4a3b', '4a-b')}`,
  ])('不把非规范地址或外部来源截成有效 ID：%s', (value) => {
    expect(extractAssetIds(value)).toEqual([])
    expect(extractAssetIds(`=IMAGE("${value}")`)).toEqual([])
  })
})

// 原实现：首尾包裹符用带 $ 的可回溯正则剥离。短串上语义正确，作差分对照；长串上会二次回溯（M5R-I-04）
const LEGACY_WORDS = /[^\s"'`]+/gu
const LEGACY_WRAPPERS = /^[([{<]+|[)\]}>]+$/g
function legacyExtract(value: string): readonly string[] {
  const ids = new Set<string>()
  for (const match of value.matchAll(LEGACY_WORDS)) {
    const address = match[0].replace(LEGACY_WRAPPERS, '')
    if (isPlatformAssetAddress(address, ''))
      ids.add(address.slice('/api/assets/'.length))
  }
  return [...ids].sort()
}

describe('包裹符剥离的语义与线性耗时（M5R-I-04）', () => {
  const alphabet = ['(', '[', '{', '<', ')', ']', '}', '>', 'x', '/']
  const affixes = ['']
  for (const first of alphabet) {
    affixes.push(first)
    for (const second of alphabet)
      affixes.push(first + second)
  }

  it('地址前后各接零到两个包裹符或普通字符时，与原语义逐一一致', () => {
    let checked = 0
    for (const before of affixes) {
      for (const after of affixes) {
        for (const value of [`${before}${url(A)}${after}`, `${before}${url(A)}${after} ${url(B)}`, `=IMAGE("${before}${url(A)}${after}")`]) {
          expect(extractAssetIds(value), value).toEqual(legacyExtract(value))
          checked += 1
        }
      }
    }
    expect(checked).toBe(affixes.length * affixes.length * 3)
  })

  it('只有包裹符、包裹符夹在地址中间或词首词尾交错时，与原语义一致', () => {
    for (const value of ['((', '))', '()', ')(', '<>', `)(${url(A)})(`, `(${url(A).slice(0, 12)})${url(A).slice(12)}`, `${url(A)})x)`, `((${url(A)}))`, `([{<${url(A)}>}])`])
      expect(extractAssetIds(value), value).toEqual(legacyExtract(value))
  })

  it.each([
    { name: '长串结尾包裹符后接普通字符', value: `${')'.repeat(200_000)}x`, ids: [] },
    { name: '地址前缀后接长串结尾包裹符与普通字符', value: `/api/assets/${')'.repeat(200_000)}x`, ids: [] },
    { name: '长串开头包裹符', value: `${'('.repeat(200_000)}x/api/assets/`, ids: [] },
    { name: '合法地址被长串包裹符包住', value: `${'('.repeat(200_000)}${url(A)}${')'.repeat(200_000)}`, ids: [A] },
  ])('对抗长度在线性时间内完成且结果正确：$name', ({ value, ids }) => {
    const started = Date.now()
    const result = extractAssetIds(value)
    const elapsed = Date.now() - started
    expect(result).toEqual(ids)
    // 原实现在 20 万字符上约需 20 秒（二次回溯）；线性实现为毫秒级。上限留足慢机器余量
    expect(elapsed).toBeLessThan(1000)
  })
})
