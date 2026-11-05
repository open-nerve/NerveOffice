import { describe, expect, it, vi } from 'vitest'
import { IMAGE_FRAGMENT_LIMITS, imageTransition, normalizeImageAxis, normalizeImageCell, normalizeImageCells, normalizeImageFragment } from './image-source-policy.ts'

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

describe('大范围写入按片段计预算（M5R-I-01）', () => {
  const grid = (rows: number, columns: number, cell: (row: number) => unknown): Record<number, Record<number, unknown>> =>
    Object.fromEntries(Array.from({ length: rows }, (_, row) => [row, Object.fromEntries(Array.from({ length: columns }, (_, column) => [column, cell(row)]))]))
  const side = () => ({ s: 1, cl: { rgb: '#000000' } })
  const border = () => ({ bd: { t: side(), b: side(), l: side(), r: side() } })
  // 链接格的富文本形态：段落、文字样式、超链接范围与无限页面尺寸，每格三十余个节点
  const link = (row: number) => ({
    id: `link-${row}`,
    body: {
      dataStream: `链接${row}\r\n`,
      textRuns: [{ st: 0, ed: 4, ts: { cl: { rgb: '#1155cc' }, ul: { s: 1 } } }],
      paragraphs: [{ startIndex: 5, paragraphStyle: { horizontalAlign: 0 } }],
      customRanges: [{ startIndex: 0, endIndex: 4, rangeId: `range-${row}`, rangeType: 0, properties: { url: 'https://example.com/page' } }],
      sectionBreaks: [{ startIndex: 6 }],
    },
    documentStyle: { pageSize: { width: Infinity, height: Infinity } },
  })

  it.each([
    { name: '撤销与清除形态 {p:null, s:null} 6 万格', matrix: () => grid(3_000, 20, () => ({ v: 1, p: null, s: null })) },
    { name: '加粗 6 万格', matrix: () => grid(3_000, 20, () => ({ s: { bl: 1 } })) },
    { name: '四边框 6,000 格', matrix: () => grid(300, 20, () => ({ s: border() })) },
    { name: '链接富文本 5,000 格', matrix: () => grid(5_000, 1, row => ({ p: link(row) })) },
    { name: '带格式粘贴 1 万格（样式＋富文本）', matrix: () => grid(500, 20, row => ({ v: 'x', s: { bl: 1, ...border() }, p: link(row) })) },
  ])('$name：不被图片预算拒绝，矩阵身份不变', ({ matrix }) => {
    const value = matrix()
    const result = normalizeImageCells(value, ORIGIN)
    expect(result).toEqual({ ok: true, changed: false, value })
    if (result.ok)
      expect(result.value).toBe(value)
  })

  it('行列样式 6 万项同样按片段计预算', () => {
    const value = Object.fromEntries(Array.from({ length: 60_000 }, (_, row) => [row, { h: 20, s: { bl: 1 } }]))
    expect(normalizeImageAxis(value, ORIGIN)).toEqual({ ok: true, changed: false, value })
  })

  it('大范围写入里的非法来源仍整批拒绝；同源绝对地址仍被归一', () => {
    const value = grid(3_000, 20, () => ({ s: { bl: 1 } }))
    value[2_999]![19] = { s: { fill: { source: 'https://outside.example/a.png' } } }
    expect(normalizeImageCells(value, ORIGIN)).toEqual({ ok: false, reason: 'source' })
    value[2_999]![19] = { p: { drawings: { i: { source: `${ORIGIN}${SOURCE}` } } } }
    const result = normalizeImageCells(value, ORIGIN)
    expect(result.ok && result.changed).toBe(true)
    if (result.ok)
      expect((result.value as typeof value)[2_999]![19]).toEqual({ p: { drawings: { i: { source: SOURCE } } } })
  })

  it('单个片段仍受规模与深度上限约束，原因分类为 limit', () => {
    const wide = { p: { body: { textRuns: Array.from({ length: IMAGE_FRAGMENT_LIMITS.entries + 1 }, () => ({ st: 0 })) } } }
    expect(normalizeImageCells({ 0: { 0: wide } }, ORIGIN)).toEqual({ ok: false, reason: 'limit' })
    let deep: unknown = { source: SOURCE }
    for (let i = 0; i <= IMAGE_FRAGMENT_LIMITS.depth; i++)
      deep = { child: deep }
    expect(normalizeImageCells({ 0: { 0: { s: deep } } }, ORIGIN)).toEqual({ ok: false, reason: 'limit' })
  })

  it('状态迁移的拒绝带有界原因：来源、规模', () => {
    expect(imageTransition({ source: SOURCE }, { source: SOURCE })).toEqual({ ok: true })
    expect(imageTransition({ source: SOURCE }, { source: 'blob:bad' })).toEqual({ ok: false, reason: 'source' })
    expect(imageTransition({ source: SOURCE }, { source: SOURCE, base64Cache: OTHER })).toEqual({ ok: false, reason: 'source' })
    let before: unknown = 1
    let after: unknown = 2
    for (let i = 0; i <= IMAGE_FRAGMENT_LIMITS.depth; i++) {
      before = { child: before }
      after = { child: after }
    }
    expect(imageTransition(before, after)).toEqual({ ok: false, reason: 'limit' })
  })
})

describe('单元格公式里 IMAGE() 首参的本站绝对地址（M5R-I-03）', () => {
  it('写入时把首参改为相对地址，原件、其他字段与其他格保持身份', () => {
    const stable = { v: 1, f: '=SUM(A1)' }
    const matrix = { 0: { 0: { f: `=IMAGE("${ORIGIN}${SOURCE}","",0)`, v: 'x' }, 1: stable } }
    const result = normalizeImageCells(matrix, ORIGIN)
    expect(result).toEqual({ ok: true, changed: true, value: { 0: { 0: { f: `=IMAGE("${SOURCE}","",0)`, v: 'x' }, 1: stable } } })
    expect(matrix[0][0].f).toBe(`=IMAGE("${ORIGIN}${SOURCE}","",0)`)
    if (result.ok)
      expect((result.value as typeof matrix)[0][1]).toBe(stable)
  })

  it('没有本站源（历史预检）时不改写；相对地址、外站地址与非 IMAGE 文字不变', () => {
    for (const [cell, origin] of [
      [{ f: `=IMAGE("${ORIGIN}${SOURCE}")` }, ''],
      [{ f: `=IMAGE("${SOURCE}")` }, ORIGIN],
      [{ f: `=IMAGE("https://outside.example${SOURCE}")` }, ORIGIN],
      [{ f: `="${ORIGIN}${SOURCE}"` }, ORIGIN],
      [{ v: `=IMAGE("${ORIGIN}${SOURCE}")` }, ORIGIN],
    ] as const)
      expect(normalizeImageCell(cell, origin)).toEqual({ ok: true, changed: false, value: cell })
  })
})
