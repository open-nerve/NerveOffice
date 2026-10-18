import { describe, expect, it } from 'vitest'
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
