import { describe, expect, it, vi } from 'vitest'
import { IMAGE_FRAGMENT_LIMITS, normalizeImageCells, normalizeImageFragment } from './image-source-policy.ts'

const ORIGIN = 'https://docs.example.com'
const SOURCE = '/api/assets/11111111-1111-4111-8111-111111111111'
const OTHER = '/api/assets/22222222-2222-4222-8222-222222222222'

describe('图片相关片段：验证完才生成规范副本', () => {
  it('同源绝对地址和缓存归一，原件及无关分支保持原样', () => {
    const anchor = { from: { row: 1, column: 2 }, to: { row: 4, column: 5 } }
    const input = Object.freeze({ source: `${ORIGIN}${SOURCE}`, base64Cache: `${ORIGIN}${SOURCE}`, anchor })
    const result = normalizeImageFragment(input, ORIGIN)
    expect(result).toEqual({ ok: true, changed: true, value: { source: SOURCE, base64Cache: SOURCE, anchor } })
    expect(input.source).toBe(`${ORIGIN}${SOURCE}`)
    if (!result.ok)
      throw new Error('合法图片片段被拒绝')
    expect(result.value).not.toBe(input)
    if (typeof result.value !== 'object' || result.value === null)
      throw new Error('归一结果应保留对象')
    expect(Reflect.get(result.value, 'anchor')).toBe(anchor)
  })

  it('已规范的片段保持对象身份，普通文本与链接不改写', () => {
    const value = { source: SOURCE, base64Cache: SOURCE, altText: 'https://outside.example/image', url: 'https://outside.example/link' }
    const result = normalizeImageFragment(value, ORIGIN)
    expect(result).toEqual({ ok: true, changed: false, value })
    if (result.ok)
      expect(result.value).toBe(value)
  })

  it.each([
    'https://outside.example/image.png',
    'blob:local-only',
    'data:image/png;base64,AAAA',
    `${SOURCE}?q=1`,
    `${SOURCE}#x`,
    `/api/assets/%31${SOURCE.slice('/api/assets/1'.length)}`,
    '',
    null,
    0,
  ])('非法 source %j 拒绝整片段', (source) => {
    const value = [{ source: `${ORIGIN}${SOURCE}` }, { fill: { image: { source } } }]
    const before = JSON.stringify(value)
    expect(normalizeImageFragment(value, ORIGIN).ok).toBe(false)
    expect(JSON.stringify(value)).toBe(before)
  })

  it('base64Cache 不得存临时地址，source/cache 不得指向两个资源', () => {
    for (const value of [{ source: SOURCE, base64Cache: 'data:image/png;base64,AAAA' }, { source: SOURCE, base64Cache: OTHER }])
      expect(normalizeImageFragment(value, ORIGIN).ok).toBe(false)
  })

  it('只规范图片相关子树：富文本中的图片与深层填充均处理', () => {
    const value = { drawings: { image: { source: `${ORIGIN}${SOURCE}` } }, body: { textRuns: [{ ts: { fill: { source: `${ORIGIN}${SOURCE}` } } }] } }
    expect(normalizeImageFragment(value, ORIGIN)).toEqual({ ok: true, changed: true, value: { drawings: { image: { source: SOURCE } }, body: { textRuns: [{ ts: { fill: { source: SOURCE } } }] } } })
  })

  it('循环、过深、超预算和非 JSON 对象安全拒绝', () => {
    const cycle: Record<string, unknown> = {}
    cycle.child = cycle
    expect(normalizeImageFragment(cycle, ORIGIN).ok).toBe(false)
    let deep: unknown = { source: SOURCE }
    for (let i = 0; i <= IMAGE_FRAGMENT_LIMITS.depth; i++)
      deep = { child: deep }
    expect(normalizeImageFragment(deep, ORIGIN).ok).toBe(false)
    expect(normalizeImageFragment(Array.from({ length: IMAGE_FRAGMENT_LIMITS.entries + 1 }).fill(0), ORIGIN).ok).toBe(false)
    expect(normalizeImageFragment(new Date(), ORIGIN).ok).toBe(false)
  })

  it('不执行输入里的 getter，异常代理也只返回结构拒绝', () => {
    const get = vi.fn(() => {
      throw new Error('不能执行')
    })
    const value = Object.defineProperty({ source: `${ORIGIN}${SOURCE}` }, 'nested', { get, enumerable: true })
    expect(normalizeImageFragment(value, ORIGIN).ok).toBe(false)
    expect(get).not.toHaveBeenCalled()
    expect(normalizeImageFragment(new Proxy({}, { ownKeys: () => {
      throw new Error('代理')
    } }), ORIGIN).ok).toBe(false)
  })

  it('共享子树不算循环；禁止原型键', () => {
    const shared = Object.freeze({ source: `${ORIGIN}${SOURCE}` })
    expect(normalizeImageFragment([shared, shared], ORIGIN)).toEqual({ ok: true, changed: true, value: [{ source: SOURCE }, { source: SOURCE }] })
    expect(normalizeImageFragment(JSON.parse('{"__proto__":{"source":"bad"}}'), ORIGIN).ok).toBe(false)
  })
})

describe('单元格写入：只处理 p 和对象样式，不递归普通值/公式', () => {
  it('普通大表的 v/f 不被图片扫描，保持矩阵身份', () => {
    const get = vi.fn(() => {
      throw new Error('不可进入普通值')
    })
    const value = Object.defineProperty({}, 'source', { get, enumerable: true })
    const matrix = Object.fromEntries(Array.from({ length: 5_000 }, (_, row) => [row, { 0: { v: value, f: '=IMAGE(A1)' } }]))
    const result = normalizeImageCells(matrix, ORIGIN)
    expect(result).toEqual({ ok: true, changed: false, value: matrix })
    if (result.ok)
      expect(result.value).toBe(matrix)
    expect(get).not.toHaveBeenCalled()
  })

  it('富文本/样式图片归一，其他格子保持身份', () => {
    const stable = { v: '文字', s: 'style-id' }
    const matrix = { 0: { 0: { p: { drawings: { i: { source: `${ORIGIN}${SOURCE}` } } } }, 1: stable }, 1: { 0: { s: { fill: { source: `${ORIGIN}${SOURCE}` } } } } }
    const result = normalizeImageCells(matrix, ORIGIN)
    expect(result).toEqual({ ok: true, changed: true, value: { 0: { 0: { p: { drawings: { i: { source: SOURCE } } } }, 1: stable }, 1: { 0: { s: { fill: { source: SOURCE } } } } } })
    expect(matrix[0][0].p.drawings.i.source).toBe(`${ORIGIN}${SOURCE}`)
  })

  it('后一个单元格有非法图片时前一个也不改，整个写入拒绝', () => {
    const matrix = [[{ p: { drawings: { i: { source: `${ORIGIN}${SOURCE}` } } } }, { s: { fill: { source: 'blob:bad' } } }]]
    const before = JSON.stringify(matrix)
    expect(normalizeImageCells(matrix, ORIGIN).ok).toBe(false)
    expect(JSON.stringify(matrix)).toBe(before)
  })
})
