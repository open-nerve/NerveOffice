import { describe, expect, it } from 'vitest'
import { liveAssetPaths } from './live-asset-paths.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const ORIGIN = 'https://app.test'

describe('M5R-M-11 工作簿数据里仍引用的平台图片地址', () => {
  it('浮图（资源插件的 JSON 字符串）、IMAGE() 公式与单元格图片都算；规范为相对地址', () => {
    const data = {
      sheets: {
        s1: { cellData: { 0: { 0: { f: `=IMAGE("${ORIGIN}/api/assets/${B}")` }, 1: { p: { drawings: { d1: { source: `/api/assets/${C}` } } } } } } },
      },
      resources: [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ images: { data: { first: { source: `/api/assets/${A}` } } } }) }],
    }
    expect(liveAssetPaths(data, ORIGIN)).toEqual(new Set([`/api/assets/${A}`, `/api/assets/${B}`, `/api/assets/${C}`]))
  })

  it('不算外部地址、别的来源与普通文字；外部 URL 参数里的本站地址也不算', () => {
    const data = {
      cells: [
        `https://evil.test/api/assets/${A}`,
        `https://evil.test/?u=${ORIGIN}/api/assets/${B}`,
        '/api/assets/not-a-uuid',
        '普通文字',
        42,
        null,
      ],
    }
    expect(liveAssetPaths(data, ORIGIN)).toEqual(new Set())
  })

  it('很宽的数组与很深的嵌套都能遍历', () => {
    const wide = Array.from({ length: 200_000 }, (_, index) => (index === 199_999 ? `/api/assets/${A}` : 'x'))
    let deep: unknown = `/api/assets/${B}`
    for (let i = 0; i < 20_000; i++)
      deep = { next: deep }
    expect(liveAssetPaths({ wide, deep }, ORIGIN)).toEqual(new Set([`/api/assets/${A}`, `/api/assets/${B}`]))
  })
})
