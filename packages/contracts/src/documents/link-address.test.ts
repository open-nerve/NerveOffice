import { describe, expect, it } from 'vitest'
import { LINK_ADDRESS_CASES } from './link-address.test-support.ts'
import { canonicalLink, checkCellLinks, HYPERLINK_RANGE_TYPE, LINK_ADDRESS_INVALID_REASONS, LINK_ADDRESS_MAX_LENGTH, normalizeCellLinks } from './link-address.ts'

describe('链接地址的规范写法（跨引擎的同一组用例，link-address.test-support.ts）', () => {
  it('用例覆盖每一种不合法的原因，输入不重复', () => {
    const reasons = new Set(LINK_ADDRESS_CASES.flatMap(item => item.expected.ok ? [] : [item.expected.reason]))
    expect([...reasons].sort()).toEqual([...LINK_ADDRESS_INVALID_REASONS].sort())
    expect(new Set(LINK_ADDRESS_CASES.map(item => item.input)).size).toBe(LINK_ADDRESS_CASES.length)
  })

  it.each(LINK_ADDRESS_CASES.map(item => [item.note, item] as const))('%s', (_note, item) => {
    expect(canonicalLink(item.input)).toEqual(item.expected)
  })

  it('规范写法是不动点：再判定一次不变', () => {
    for (const item of LINK_ADDRESS_CASES) {
      if (item.expected.ok)
        expect(canonicalLink(item.expected.href), item.input).toEqual(item.expected)
    }
  })

  it('长度上限是 2,048 个 UTF-16 码元', () => {
    expect(LINK_ADDRESS_MAX_LENGTH).toBe(2048)
  })

  it('任何字符串都不抛出，合法时结果是不动点（随机拼出的地址）', () => {
    const pieces = ['https:', 'http:', 'mailto:', '//', '/', '\\', '#', '?', '@', ':', '.', '..', '%', '%2e', '%zz', '|', ' ', ' ', '"', '\'', '<', '`', '[', ']', '::1', 'a', 'B', '例', '😀', '\uD800', '\t', 'example.com', 'xn--', '0x7f', ':443', 'user:pw@']
    let seed = 7
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed
    }
    for (let round = 0; round < 3000; round += 1) {
      const input = Array.from({ length: 1 + (next() % 8) }, () => pieces[next() % pieces.length]).join('')
      const result = canonicalLink(input)
      if (result.ok)
        expect(canonicalLink(result.href), JSON.stringify(input)).toEqual(result)
    }
  })
})

/** 一个带链接的单元格富文本（SDK 键入网址写出的样子：p 有 id、body、documentStyle） */
function cell(text: string, ranges: readonly unknown[]): { id: string, body: { dataStream: string, customRanges: readonly unknown[] }, documentStyle: Record<string, unknown> } {
  return { id: 'd', body: { dataStream: `${text}\r\n`, customRanges: ranges }, documentStyle: {} }
}

function link(url: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { startIndex: 0, endIndex: 3, rangeId: 'r1', rangeType: HYPERLINK_RANGE_TYPE, properties: { url }, ...overrides }
}

function rangesOf(p: { body: { customRanges: readonly unknown[] } }): readonly unknown[] {
  return p.body.customRanges
}

describe('页面写入之前的改写（normalizeCellLinks，DEF-021）', () => {
  it('链接的 rangeType 是 Univer 的 CustomRangeType.HYPERLINK（0）', () => {
    expect(HYPERLINK_RANGE_TYPE).toBe(0)
  })

  it('改成规范写法（SDK 键入 example.com 写出 https://example.com）：换上新的数组与新的区间对象，原来的不改', () => {
    const original = link('https://example.com', { endIndex: 10 })
    const p = cell('example.com', [original])
    expect(normalizeCellLinks(p)).toBe(true)
    expect(rangesOf(p)).toEqual([{ ...original, properties: { url: 'https://example.com/' } }])
    expect(original.properties).toEqual({ url: 'https://example.com' })
    expect(p.body.dataStream).toBe('example.com\r\n')
  })

  it('SDK 键入邮箱写出的 mailto:// 修成 mailto:（协议不区分大小写）', () => {
    const p = cell('user@example.com', [link('mailto://user@example.com'), link('MAILTO://a@b.example', { rangeId: 'r2' })])
    expect(normalizeCellLinks(p)).toBe(true)
    expect(rangesOf(p).map(range => (range as { properties: { url: string } }).properties.url)).toEqual(['mailto:user@example.com', 'mailto:a@b.example'])
  })

  it('地址不合法、覆盖的文字是合法的绝对地址时改用这段文字（单元格编辑器里粘贴两行：地址是整段文字、带换行）', () => {
    const text = 'first line https://example.com/a b'
    const p = cell(text, [link('first line\nhttps://example.com/a b', { startIndex: 11, endIndex: text.length - 1 })])
    expect(normalizeCellLinks(p)).toBe(true)
    expect(rangesOf(p)).toEqual([link('https://example.com/a%20b', { startIndex: 11, endIndex: text.length - 1 })])
  })

  it.each([
    ['粘贴纯文本写出的 example.org（文字也不是绝对地址）', 'example.org', 'example.org'],
    ['ftp（SDK 键入时照样识别）', 'ftp://example.com/x', 'ftp://example.com/x'],
    ['javascript', 'javascript:alert(1)', 'javascript:alert(1)'],
    ['粘贴 HTML 写出的相对地址，文字是本站相对地址（不算绝对地址）', 'relative-no-slash', '/x'],
    ['文字是锚点', 'x y', '#top'],
  ])('仍不合法就去掉这一段链接、保留文字：%s', (_case, url, text) => {
    const other = { startIndex: 0, endIndex: 0, rangeId: 'c1', rangeType: 6, properties: { url: 'javascript:void(0)' } }
    const p = cell(text, [other, link(url, { endIndex: text.length - 1 })])
    expect(normalizeCellLinks(p)).toBe(true)
    expect(rangesOf(p)).toEqual([other])
    expect(p.body.dataStream).toBe(`${text}\r\n`)
  })

  it('覆盖的下标不合理时不用文字：去掉链接', () => {
    for (const range of [{ startIndex: 5, endIndex: 2 }, { startIndex: -1, endIndex: 2 }, { startIndex: 0, endIndex: 99 }, { startIndex: 0.5, endIndex: 2 }, { startIndex: '0', endIndex: 2 }]) {
      const p = cell('https://example.com/', [link('bad', range)])
      expect(normalizeCellLinks(p), JSON.stringify(range)).toBe(true)
      expect(rangesOf(p)).toEqual([])
    }
    const noText = { id: 'd', body: { customRanges: [link('bad')] } }
    expect(normalizeCellLinks(noText)).toBe(true)
    expect(noText.body.customRanges).toEqual([])
  })

  it('rangeId 不合写法的换掉：link-<下标>，与同一个单元格里已有的重复时再加序号', () => {
    const p = cell('abcd', [link('https://a.example/', { rangeId: '"><img src=x>' }), link('https://b.example/', { rangeId: 'link-0' }), link('https://c.example/', { rangeId: '' }), link('https://d.example/', { rangeId: 7 })])
    expect(normalizeCellLinks(p)).toBe(true)
    expect(rangesOf(p).map(range => (range as { rangeId: unknown }).rangeId)).toEqual(['link-0-1', 'link-0', 'link-2', 'link-3'])
  })

  it('别的种类的区间原样保留（只改链接）', () => {
    const mention = { startIndex: 0, endIndex: 1, rangeId: 'not valid id!', rangeType: 6, properties: { url: 'example.org' } }
    const p = cell('ab', [mention])
    expect(normalizeCellLinks(p)).toBe(false)
    expect(rangesOf(p)[0]).toBe(mention)
  })

  it('已经是规范写法：什么也不改（数组不换）', () => {
    const ranges = [link('https://example.com/'), link('#gid=sheet-1&range=A1', { rangeId: 'r2' }), link('mailto:a@b.example', { rangeId: 'r3' })]
    const p = cell('abcd', ranges)
    expect(normalizeCellLinks(p)).toBe(false)
    expect(rangesOf(p)).toBe(ranges)
  })

  it('看不懂的结构按不合法处理：customRanges 不是数组时清空，不是对象的项去掉，链接没有字符串的地址时去掉', () => {
    const notArray = { body: { dataStream: 'x', customRanges: { 0: link('https://example.com/') } } }
    expect(normalizeCellLinks(notArray)).toBe(true)
    expect(notArray.body.customRanges).toEqual([])
    const p = cell('abcd', [null, 1, 'x', [link('https://example.com/')], link(undefined), link(5), { ...link(''), properties: 'https://example.com/' }, { ...link(''), properties: undefined }, link('https://ok.example/')])
    expect(normalizeCellLinks(p)).toBe(true)
    expect(rangesOf(p)).toEqual([link('https://ok.example/')])
  })

  it('没有链接时什么也不做：p 不是对象、没有正文、正文不是对象、没有区间、区间是 null', () => {
    for (const p of [undefined, null, 'p', 1, [], { body: null }, { body: 'x' }, { body: [] }, { body: { dataStream: 'x' } }, { body: { customRanges: null } }, { body: { customRanges: [] } }])
      expect(normalizeCellLinks(p), JSON.stringify(p)).toBe(false)
  })

  it('结果一定通过服务端的核对（checkCellLinks）', () => {
    const samples = [
      cell('example.com', [link('https://example.com')]),
      cell('x', [link('mailto://x@y.example'), link('first\nhttps://e.example', { rangeId: 'r2' }), link('ftp://x', { rangeId: 'bad id' })]),
      { body: { customRanges: 'x' } },
      cell('ab', [null, link(undefined), link('/a|b', { rangeId: '"' })]),
    ]
    for (const p of samples) {
      normalizeCellLinks(p)
      expect(checkCellLinks(p), JSON.stringify(p)).toEqual({ ok: true })
    }
  })
})

describe('服务端的核对（checkCellLinks）：只判定、不改写', () => {
  it('合法并且等于规范写法、rangeId 合写法：通过；不改 p', () => {
    const p = cell('abcd', [link('https://example.com/'), link('/doc?x=1#y', { rangeId: 'r_2-x' }), link('#gid=s&range=A1', { rangeId: 'A'.repeat(64) })])
    const before = JSON.stringify(p)
    expect(checkCellLinks(p)).toEqual({ ok: true })
    expect(JSON.stringify(p)).toBe(before)
  })

  it.each([
    ['不是规范写法（少了路径的 /）', 'https://example.com'],
    ['SDK 键入邮箱写出的 mailto://', 'mailto://user@example.com'],
    ['不合法的协议', 'javascript:alert(1)'],
    ['没有协议', 'example.org'],
    ['路径里的 |（规范写法是 %7C）', 'https://example.com/a|b'],
    ['首尾空白', ' https://example.com/'],
  ])('link-address：%s', (_case, url) => {
    expect(checkCellLinks(cell('abcd', [link(url)]))).toEqual({ ok: false, rule: 'link-address' })
  })

  it.each(['', 'a"b', 'a b', 'A'.repeat(65), 7, undefined])('link-range-id：%j', (rangeId) => {
    expect(checkCellLinks(cell('abcd', [link('https://example.com/', { rangeId })]))).toEqual({ ok: false, rule: 'link-range-id' })
  })

  it.each([
    ['customRanges 不是数组', { body: { customRanges: {} } }],
    ['某一项不是对象', cell('a', [null])],
    ['链接没有 properties', cell('a', [{ ...link(''), properties: undefined }])],
    ['链接的地址不是字符串', cell('a', [link(1)])],
  ])('link-structure：%s', (_case, p) => {
    expect(checkCellLinks(p)).toEqual({ ok: false, rule: 'link-structure' })
  })

  it('别的种类的区间不看；没有正文、没有区间、区间是 null：通过', () => {
    expect(checkCellLinks(cell('a', [{ startIndex: 0, endIndex: 0, rangeId: '!!', rangeType: 2, properties: { url: 'javascript:x' } }]))).toEqual({ ok: true })
    for (const p of [undefined, null, 'p', {}, { body: null }, { body: {} }, { body: { customRanges: null } }])
      expect(checkCellLinks(p), JSON.stringify(p)).toEqual({ ok: true })
  })

  it('逐个区间，第一条不满足的就是结果', () => {
    expect(checkCellLinks(cell('abcd', [link('https://ok.example/'), link('https://bad.example'), null]))).toEqual({ ok: false, rule: 'link-address' })
    expect(checkCellLinks(cell('abcd', [link('https://bad.example', { rangeId: '!' })]))).toEqual({ ok: false, rule: 'link-address' })
  })
})
