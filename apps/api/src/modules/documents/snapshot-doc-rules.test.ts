// 文字文档（doc@1）的服务端规则（M6-P1 S3、S4 spec §3）：经 PROFILE_SNAPSHOT_RULES['doc@1'] 逐项核对，同时核对档案的装配。
// 整条检查的先后、M0 样本不误拒与内容哈希在 snapshot-inspection.test.ts
import type { SnapshotImageLocation, SnapshotLinkLocation } from '@nerve-office/contracts'
import type { CheckedStructure, EmbeddedJson } from './snapshot-checks.ts'
import { HYPERLINK_RANGE_TYPE, sheetSnapshotFor } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { docSnapshot, savedDocResources } from './doc-snapshot.test-support.ts'
import { embeddedJson, PROFILE_SNAPSHOT_RULES } from './snapshot-checks.ts'

const UNIT_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const ASSET = '/api/assets/0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const DOC = PROFILE_SNAPSHOT_RULES['doc@1']
/** Univer 的 CustomRangeType：FIELD 1、BOOKMARK 3 */
const FIELD_RANGE_TYPE = 1
const BOOKMARK_RANGE_TYPE = 3

function doc(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}): Record<string, unknown> {
  return docSnapshot(UNIT_ID, overrides, body)
}

function checked(snapshot: unknown): CheckedStructure {
  const result = DOC.structure(snapshot)
  if (result === undefined)
    throw new Error('结构不对')
  return result
}

function embedded(snapshot: unknown): readonly EmbeddedJson[] {
  const values = embeddedJson(snapshot, { entries: 0 })
  if (typeof values === 'string')
    throw new Error(`资源超限：${values}`)
  return values
}

function content(snapshot: unknown): string {
  const check = DOC.content(checked(snapshot))
  return check.ok ? 'ok' : check.rule
}

function links(snapshot: unknown): { readonly rule: string, readonly linkLocations?: readonly SnapshotLinkLocation[] } {
  const check = DOC.links(checked(snapshot))
  return check.ok ? { rule: 'ok' } : { rule: check.rule, linkLocations: check.linkLocations }
}

function consistency(snapshot: unknown): string {
  const check = DOC.consistency(checked(snapshot), embedded(snapshot))
  return check.ok ? 'ok' : check.rule
}

function images(snapshot: unknown): readonly SnapshotImageLocation[] {
  return DOC.imageLocations(checked(snapshot), embedded(snapshot))
}

function link(startIndex: number, url: unknown, rangeId: unknown = `r${startIndex}`): Record<string, unknown> {
  return { startIndex, endIndex: startIndex + 1, rangeId, rangeType: HYPERLINK_RANGE_TYPE, properties: { url } }
}

function field(fieldType: unknown, startIndex = 0): Record<string, unknown> {
  return { startIndex, endIndex: startIndex + 1, rangeId: `f${startIndex}`, rangeType: FIELD_RANGE_TYPE, wholeEntity: false, properties: { fieldType, instruction: `${String(fieldType)} \\h` } }
}

describe('文字文档的结构（doc@1 的 structure）', () => {
  it('SDK 保存的形状通过，unitId 是顶层的 id；只有 id、body 与 dataStream 也通过（M0 手写的种子）', () => {
    expect(checked(doc()).unitId).toBe(UNIT_ID)
    expect(DOC.structure({ id: UNIT_ID, body: { dataStream: '\r\n' } })?.unitId).toBe(UNIT_ID)
  })

  it.each([
    ['表格的模板', JSON.parse(sheetSnapshotFor(UNIT_ID)) as unknown],
    ['不是对象', []],
    ['null', null],
    ['id 是空串', doc({ id: '' })],
    ['id 不是字符串', doc({ id: 7 })],
    ['没有正文', doc({ body: undefined })],
    ['正文是数组', doc({ body: [] })],
    ['dataStream 不是字符串', doc({}, { dataStream: 1 })],
    ['没有 dataStream', doc({}, { dataStream: undefined })],
    ['paragraphs 不是数组', doc({}, { paragraphs: {} })],
    ['sectionBreaks 是 null', doc({}, { sectionBreaks: null })],
    ['tables 是对象', doc({}, { tables: {} })],
    ['customRanges 是字符串', doc({}, { customRanges: 'x' })],
    ['customBlocks 是 null', doc({}, { customBlocks: null })],
    ['documentStyle 是数组', doc({ documentStyle: [] })],
    ['headers 是字符串', doc({ headers: 'x' })],
    ['footers 是 null', doc({ footers: null })],
    ['drawings 是数组', doc({ drawings: [] })],
    ['drawingsOrder 是对象', doc({ drawingsOrder: {} })],
  ])('不通过：%s', (_case, snapshot) => {
    expect(DOC.structure(snapshot)).toBeUndefined()
  })
})

describe('文字文档的版式、页眉页脚、脚注尾注、分节符与目录块（doc@1 的 content）', () => {
  it('SDK 保存的形状通过', () => {
    expect(content(doc())).toBe('ok')
  })

  it.each([0, 1, 3, '2', null])('doc-flavor：documentFlavor 是 %j', (documentFlavor) => {
    expect(content(doc({ documentStyle: { documentFlavor } }))).toBe('doc-flavor')
  })

  it('doc-flavor：没有 documentFlavor，或者没有 documentStyle', () => {
    expect(content(doc({ documentStyle: {} }))).toBe('doc-flavor')
    expect(content(doc({ documentStyle: undefined }))).toBe('doc-flavor')
  })

  it('doc-header-footer：有一个页眉或页脚，里面有正文；深层为空的照常通过，documentStyle 里页眉页脚的 id 不单独判', () => {
    expect(content(doc({ headers: { h1: { headerId: 'h1', body: { dataStream: '页眉\r\n' } } } }))).toBe('doc-header-footer')
    expect(content(doc({ footers: { f1: { footerId: 'f1', body: { dataStream: '\r\n' } } } }))).toBe('doc-header-footer')
    expect(content(doc({ headers: { h1: {} }, footers: { f1: { body: {} } } }))).toBe('ok')
    expect(content(doc({ headers: undefined, footers: undefined, documentStyle: { documentFlavor: 2, defaultHeaderId: 'h1', defaultFooterId: 'f1' } }))).toBe('ok')
  })

  it('doc-notes：有一条脚注，或者 docx 的脚注尾注；noteSettings 不判', () => {
    expect(content(doc({ notes: { n1: { noteId: 'n1', type: 'footnote', body: { dataStream: '注\r\n' } } } }))).toBe('doc-notes')
    expect(content(doc({ footnotes: { n1: { noteId: 'n1', type: 'normal', body: { dataStream: '注\r\n' } } } }))).toBe('doc-notes')
    expect(content(doc({ endnotes: { n1: { noteId: 'n1' } } }))).toBe('doc-notes')
    expect(content(doc({ notes: { n1: {} }, footnotes: {}, endnotes: [], noteSettings: { footnote: { numberFormat: 'decimal' } } }))).toBe('ok')
  })

  it('页眉页脚先于脚注尾注：两样都有时是 doc-header-footer', () => {
    expect(content(doc({ headers: { h1: { headerId: 'h1' } }, notes: { n1: { noteId: 'n1' } } }))).toBe('doc-header-footer')
  })

  describe('doc-section-break：表格之外至多一个分节符，有的话在文末', () => {
    // dataStream 是“第一段\r第二段\r\n”，文末的 \n 在 8
    it('没有分节符、文末一个都通过', () => {
      expect(content(doc())).toBe('ok')
      expect(content(doc({}, { sectionBreaks: [{ startIndex: 8 }] }))).toBe('ok')
    })

    it('唯一的一个不在文末、表格之外有两个、文末的写了两次：不通过', () => {
      expect(content(doc({}, { sectionBreaks: [{ startIndex: 3 }] }))).toBe('doc-section-break')
      expect(content(doc({}, { sectionBreaks: [{ startIndex: 3 }, { startIndex: 8 }] }))).toBe('doc-section-break')
      expect(content(doc({}, { sectionBreaks: [{ startIndex: 8 }, { startIndex: 8 }] }))).toBe('doc-section-break')
    })

    // 表格在 dataStream 里的写法同 SDK（docs-ui 的 buildDocTableInsertBody，M0 的 doc-table 样本）：区间的起点是表格开始 \x1A，终点是表格结束 \x0F
    // 之后的那个 \r；单元格是 \x1C\r\n\x1D，其中的 \n 是单元格的分节符。这里的输入只带表格开始与结束两个控制符、没有行与单元格的控制符，
    // 够这条规则用：它只核对区间的两端（按控制符的完整结构判定见 DEF-089）。TABLE：下标 0 a、1 b、2 \x1A、3 \n、4 \x0F、5 \r、6 c、7 d、8 \n（文末）
    const TABLE = 'ab\x1A\n\x0F\rcd\n'

    it('表格里每个单元格各有一个（含区间的两端）：不算；表格之外照常数', () => {
      const tables = [{ startIndex: 2, endIndex: 5, tableId: 't1' }]
      expect(content(doc({}, { dataStream: TABLE, tables, sectionBreaks: [{ startIndex: 2 }, { startIndex: 4 }, { startIndex: 5 }] }))).toBe('ok')
      expect(content(doc({}, { dataStream: TABLE, tables, sectionBreaks: [{ startIndex: 4 }, { startIndex: 8 }] }))).toBe('ok')
      expect(content(doc({}, { dataStream: TABLE, tables, sectionBreaks: [{ startIndex: 4 }, { startIndex: 6 }] }))).toBe('doc-section-break')
    })

    it('表格的先后与重叠不影响判断（区间排序合并）', () => {
      // 下标：0 \x1A、1 \n、2 \x1A、3 \x0F、4 \n、5 \x0F、6 \r、7 x、8 \x1A、9 \x0F、10 \r、11 y、12 \n（文末）。[0, 4] 与 [2, 6] 交叠，合并成 [0, 6]
      const dataStream = '\x1A\n\x1A\x0F\n\x0F\rx\x1A\x0F\ry\n'
      const tables = [{ startIndex: 8, endIndex: 10 }, { startIndex: 0, endIndex: 4 }, { startIndex: 2, endIndex: 6 }]
      expect(content(doc({}, { dataStream, tables, sectionBreaks: [{ startIndex: 0 }, { startIndex: 3 }, { startIndex: 4 }, { startIndex: 6 }, { startIndex: 8 }, { startIndex: 10 }, { startIndex: 12 }] }))).toBe('ok')
      expect(content(doc({}, { dataStream, tables, sectionBreaks: [{ startIndex: 7 }] }))).toBe('doc-section-break')
    })

    it('嵌套的表格：内表格在外表格的单元格里，外表格里排在内表格之后的分节符照样算表格里的（合并取两个终点之大），表格的先后不影响', () => {
      // 下标：0 \x1A、1 \n、2 \x1A、3 \n、4 \x0F、5 \r、6 \n、7 \x0F、8 \r、9 x、10 \n（文末）。外表格 [0, 8] 包住内表格 [2, 5]（P1 复验的 Minor-2）
      const dataStream = '\x1A\n\x1A\n\x0F\r\n\x0F\rx\n'
      const tables = [{ startIndex: 0, endIndex: 8 }, { startIndex: 2, endIndex: 5 }]
      for (const order of [tables, tables.toReversed()]) {
        expect(content(doc({}, { dataStream, tables: order, sectionBreaks: [{ startIndex: 1 }, { startIndex: 3 }, { startIndex: 6 }, { startIndex: 10 }] }))).toBe('ok')
        expect(content(doc({}, { dataStream, tables: order, sectionBreaks: [{ startIndex: 9 }] }))).toBe('doc-section-break')
      }
    })

    it('写法不对的表格不算表格；写法不对的分节符按表格之外算', () => {
      expect(content(doc({}, { dataStream: TABLE, tables: [{ startIndex: '2', endIndex: 5 }, null, { startIndex: 5, endIndex: 2 }], sectionBreaks: [{ startIndex: 4 }] }))).toBe('doc-section-break')
      expect(content(doc({}, { sectionBreaks: [{}] }))).toBe('doc-section-break')
      expect(content(doc({}, { sectionBreaks: ['x'] }))).toBe('doc-section-break')
      expect(content(doc({}, { sectionBreaks: [{ startIndex: 8.5 }] }))).toBe('doc-section-break')
    })

    it('表格以 dataStream 里的控制符为准：起点不是表格开始（\\x1A）或终点的前一位不是表格结束（\\x0F）的区间不算表格，两端不落在控制符上的伪造区间藏不住分节符', () => {
      // 正文里没有表格，tables 却声称有一个盖住第一段的表格（P1 审查 A 的 M-1）
      expect(content(doc({}, { tables: [{ startIndex: 0, endIndex: 7, tableId: 't1' }], sectionBreaks: [{ startIndex: 3 }, { startIndex: 8 }] }))).toBe('doc-section-break')
      // 只有一端是控制符
      expect(content(doc({}, { dataStream: 'ab\x1A\nx\rcd\n', tables: [{ startIndex: 2, endIndex: 5 }], sectionBreaks: [{ startIndex: 3 }, { startIndex: 8 }] }))).toBe('doc-section-break')
      expect(content(doc({}, { dataStream: 'abx\n\x0F\rcd\n', tables: [{ startIndex: 2, endIndex: 5 }], sectionBreaks: [{ startIndex: 3 }, { startIndex: 8 }] }))).toBe('doc-section-break')
      // 两端都对：照常是表格
      expect(content(doc({}, { dataStream: TABLE, tables: [{ startIndex: 2, endIndex: 5 }], sectionBreaks: [{ startIndex: 3 }, { startIndex: 8 }] }))).toBe('ok')
    })

    it('规模：十万个表格、每个表格里一个分节符，按排序二分判断（不随两者的乘积增长）', () => {
      const count = 100_000
      // 每个表格四个字符：\x1A、单元格的分节符 \n、\x0F、表格之后的 \r；区间是 [index * 4, index * 4 + 3]
      const tables = Array.from({ length: count }, (_, index) => ({ startIndex: index * 4, endIndex: index * 4 + 3 }))
      const sectionBreaks = Array.from({ length: count }, (_, index) => ({ startIndex: index * 4 + 1 }))
      const dataStream = `${'\x1A\n\x0F\r'.repeat(count)}x\n`
      // 逐对比较要一百亿次，远超默认时限；排序二分是几十毫秒
      expect(content(doc({}, { dataStream, paragraphs: [], tables: tables.toReversed(), sectionBreaks: [...sectionBreaks, { startIndex: count * 4 + 1 }] }))).toBe('ok')
      // 最后一个表格（count * 4 - 4 到 count * 4 - 1）之后、文末之前
      expect(content(doc({}, { dataStream, paragraphs: [], tables, sectionBreaks: [...sectionBreaks, { startIndex: count * 4 }] }))).toBe('doc-section-break')
    })
  })

  describe('doc-toc：目录块的区间', () => {
    it('FIELD 区间的 fieldType 是 TOC 或 PAGEREF：不通过', () => {
      expect(content(doc({}, { customRanges: [field('TOC')] }))).toBe('doc-toc')
      expect(content(doc({}, { customRanges: [link(0, 'https://example.com/'), field('PAGEREF', 4)] }))).toBe('doc-toc')
    })

    it('别的字段、指向锚点的链接、书签、看不懂的项都不算（链接的规则另外核对）', () => {
      expect(content(doc({}, { customRanges: [field('PAGE'), field('toc'), field(undefined), link(0, '#heading'), { rangeType: BOOKMARK_RANGE_TYPE, rangeId: 'b1', startIndex: 0, endIndex: 1 }, null, 'x', { rangeType: FIELD_RANGE_TYPE }, { rangeType: FIELD_RANGE_TYPE, properties: 'TOC' }] }))).toBe('ok')
    })

    it('目录块排在分节符之后：两样都有时是 doc-section-break', () => {
      expect(content(doc({}, { sectionBreaks: [{ startIndex: 3 }], customRanges: [field('TOC')] }))).toBe('doc-section-break')
    })
  })

  it('先后：版式 → 页眉页脚 → 脚注尾注 → 分节符 → 目录块', () => {
    const all = doc({ documentStyle: { documentFlavor: 1 }, headers: { h: { headerId: 'h' } }, notes: { n: { noteId: 'n' } } }, { sectionBreaks: [{ startIndex: 3 }], customRanges: [field('TOC')] })
    expect(content(all)).toBe('doc-flavor')
    expect(content({ ...all, documentStyle: { documentFlavor: 2 } })).toBe('doc-header-footer')
    expect(content({ ...all, documentStyle: { documentFlavor: 2 }, headers: {} })).toBe('doc-notes')
  })
})

describe('文字文档里的链接（doc@1 的 links）：作用于正文的 customRanges，位置是段落', () => {
  it('规范写法的链接、锚点、别的种类的区间都通过；没有 customRanges 也通过', () => {
    expect(links(doc({}, { customRanges: [link(0, 'https://example.com/'), link(4, '#title'), field('PAGE')] }))).toEqual({ rule: 'ok' })
    expect(links(doc({}, { customRanges: undefined }))).toEqual({ rule: 'ok' })
  })

  it('每一条链接规则报出区间起点所在的段落（从 0 起：第一个 startIndex 不小于区间起点的段落）', () => {
    expect(links(doc({}, { customRanges: [link(0, 'https://example.com')] }))).toEqual({ rule: 'link-address', linkLocations: [{ kind: 'paragraph', paragraph: 0 }] })
    expect(links(doc({}, { customRanges: [link(3, 'javascript:alert(1)')] }))).toEqual({ rule: 'link-address', linkLocations: [{ kind: 'paragraph', paragraph: 0 }] })
    expect(links(doc({}, { customRanges: [link(4, 'https://example.com/', 'bad id')] }))).toEqual({ rule: 'link-range-id', linkLocations: [{ kind: 'paragraph', paragraph: 1 }] })
    expect(links(doc({}, { customRanges: [link(5, 42)] }))).toEqual({ rule: 'link-structure', linkLocations: [{ kind: 'paragraph', paragraph: 1 }] })
  })

  it('看不懂的位置说“文档里别的位置”：区间不是对象、起点不是非负整数、起点在最后一段之后', () => {
    expect(links(doc({}, { customRanges: [null] }))).toEqual({ rule: 'link-structure', linkLocations: [{ kind: 'document' }] })
    expect(links(doc({}, { customRanges: [{ ...link(0, 'x'), startIndex: '0' }] }))).toEqual({ rule: 'link-address', linkLocations: [{ kind: 'document' }] })
    expect(links(doc({}, { customRanges: [link(-1, 'x')] }))).toEqual({ rule: 'link-address', linkLocations: [{ kind: 'document' }] })
    expect(links(doc({}, { customRanges: [link(8, 'x')] }))).toEqual({ rule: 'link-address', linkLocations: [{ kind: 'document' }] })
  })

  it('段落的数组没排好也按文档里的先后算；写法不对的段落不算', () => {
    const paragraphs = [{ startIndex: 7 }, null, { startIndex: 'x' }, { startIndex: 3 }]
    expect(links(doc({}, { paragraphs, customRanges: [link(4, 'x')] }))).toEqual({ rule: 'link-address', linkLocations: [{ kind: 'paragraph', paragraph: 1 }] })
  })

  it('第一条不满足的规则是结果；同一条规则的位置去重，至多五个；别的规则的区间不收', () => {
    const paragraphs = Array.from({ length: 8 }, (_, index) => ({ startIndex: index * 2 + 1 }))
    const dataStream = `${'a\r'.repeat(8)}\n`
    const customRanges = [link(0, 'https://example.com/', 'bad id'), link(0, 'x'), link(1, 'y'), link(2, 'x'), link(4, 'x'), link(6, 'x'), link(8, 'x'), link(10, 'x'), link(12, 'x')]
    expect(links(doc({}, { dataStream, paragraphs, customRanges }))).toEqual({
      rule: 'link-range-id',
      linkLocations: [{ kind: 'paragraph', paragraph: 0 }],
    })
    expect(links(doc({}, { dataStream, paragraphs, customRanges: customRanges.slice(1) }))).toEqual({
      rule: 'link-address',
      linkLocations: [0, 1, 2, 3, 4].map(paragraph => ({ kind: 'paragraph', paragraph })),
    })
  })
})

describe('文字文档里的图片地址（doc@1 的 imageLocations）', () => {
  function drawing(id: string, source: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { drawingId: id, unitId: UNIT_ID, subUnitId: UNIT_ID, imageSourceType: 'URL', source, ...overrides }
  }

  function withDrawings(drawings: Record<string, unknown>, order = Object.keys(drawings)): Record<string, unknown> {
    return doc({ drawings, drawingsOrder: order, resources: savedDocResources(JSON.stringify({ data: drawings, order })) })
  }

  it('平台地址通过：顶层 drawings 与资源里的都是', () => {
    expect(images(withDrawings({ img1: drawing('img1', ASSET) }))).toEqual([])
  })

  it('外链：顶层 drawings 里的一张说是哪一张，资源里的同一张说是第几项资源', () => {
    expect(images(withDrawings({ img1: drawing('img1', ASSET), img2: drawing('img2', 'https://evil.example/a.png') }))).toEqual([
      { kind: 'doc-drawing', drawingId: 'img2' },
      { kind: 'resource', resourceIndex: 3 },
    ])
  })

  it('drawingId 与键不同、键不合写法：说“文档里别的位置”；正文等别处的 source 也是', () => {
    expect(images(withDrawings({ img1: drawing('other', 'data:image/png;base64,AAAA') }))).toEqual([{ kind: 'document' }, { kind: 'resource', resourceIndex: 3 }])
    expect(images(doc({ drawings: { 'a/b': drawing('a/b', 'x') }, resources: savedDocResources() }))).toEqual([{ kind: 'document' }])
    expect(images(doc({}, { customBlocks: [{ startIndex: 0, blockId: 'b', source: 'x' }] }))).toEqual([{ kind: 'document' }])
  })

  it('只有资源里是外链（与顶层不一致）：位置是那一项资源', () => {
    const drawings = { img1: drawing('img1', ASSET) }
    const snapshot = doc({ drawings, drawingsOrder: ['img1'], resources: savedDocResources(JSON.stringify({ data: { img1: drawing('img1', '/fixtures-assets/a.png') }, order: ['img1'] })) })
    expect(images(snapshot)).toEqual([{ kind: 'resource', resourceIndex: 3 }])
  })
})

describe('资源与正文的交叉核对（doc@1 的 consistency，规则 resource-mismatch）', () => {
  const LINKS = [link(0, 'https://a.example/', 'r1'), link(4, 'mailto:x@example.com', 'r2')]
  const AS_SAVED_LINKS = JSON.stringify({ links: [{ id: 'r1', payload: 'https://a.example/' }, { id: 'r2', payload: 'mailto:x@example.com' }] })

  function linked(data: string, ranges: readonly unknown[] = LINKS): Record<string, unknown> {
    return doc({ resources: savedDocResources(undefined, data) }, { customRanges: ranges })
  }

  it('链接资源与正文的链接按出现的先后一一对应：通过；只看链接，别的种类的区间不算；每一项多出的键不看', () => {
    expect(consistency(linked(AS_SAVED_LINKS))).toBe('ok')
    expect(consistency(linked(AS_SAVED_LINKS, [LINKS[0], field('PAGE'), { rangeType: BOOKMARK_RANGE_TYPE, rangeId: 'b' }, LINKS[1]]))).toBe('ok')
    expect(consistency(linked(JSON.stringify({ links: [{ id: 'r1', payload: 'https://a.example/', extra: 1 }, { id: 'r2', payload: 'mailto:x@example.com' }], extra: true })))).toBe('ok')
    expect(consistency(linked('{"links":[]}', []))).toBe('ok')
    expect(consistency(linked('', []))).toBe('ok')
  })

  it.each([
    ['地址不同（加载时资源会覆盖正文的地址）', JSON.stringify({ links: [{ id: 'r1', payload: 'https://evil.example/' }, { id: 'r2', payload: 'mailto:x@example.com' }] })],
    ['少一条', JSON.stringify({ links: [{ id: 'r1', payload: 'https://a.example/' }] })],
    ['多一条', JSON.stringify({ links: [{ id: 'r1', payload: 'https://a.example/' }, { id: 'r2', payload: 'mailto:x@example.com' }, { id: 'r3', payload: 'https://b.example/' }] })],
    ['先后不同', JSON.stringify({ links: [{ id: 'r2', payload: 'mailto:x@example.com' }, { id: 'r1', payload: 'https://a.example/' }] })],
    ['id 不同', JSON.stringify({ links: [{ id: 'r9', payload: 'https://a.example/' }, { id: 'r2', payload: 'mailto:x@example.com' }] })],
    ['空串（等于没有链接），正文却有', ''],
  ])('链接资源不一致：%s', (_case, data) => {
    expect(consistency(linked(data))).toBe('resource-mismatch')
  })

  it('链接资源不在：不判（资源消失由不缩水管）', () => {
    expect(consistency(doc({ resources: savedDocResources().filter(resource => resource.name !== 'DOC_HYPER_LINK_PLUGIN') }, { customRanges: LINKS }))).toBe('ok')
    expect(consistency(doc({ resources: undefined }, { customRanges: LINKS }))).toBe('ok')
  })

  describe('图片资源', () => {
    const drawings = { img1: { drawingId: 'img1', source: ASSET, docTransform: { size: { width: 120, height: 80 } } }, img2: { drawingId: 'img2', source: ASSET } }

    function drawn(data: string, top: Record<string, unknown> = { drawings, drawingsOrder: ['img1', 'img2'] }): Record<string, unknown> {
      return doc({ ...top, resources: savedDocResources(data) })
    }

    it('data 等于顶层的 drawings、order 等于 drawingsOrder：通过；对象不看键序，多出的键不看；都没有时与空的相等', () => {
      expect(consistency(drawn(JSON.stringify({ data: drawings, order: ['img1', 'img2'] })))).toBe('ok')
      const reordered = { img2: { source: ASSET, drawingId: 'img2' }, img1: { docTransform: { size: { height: 80, width: 120 } }, source: ASSET, drawingId: 'img1' } }
      expect(consistency(drawn(JSON.stringify({ order: ['img1', 'img2'], data: reordered, extra: 1 })))).toBe('ok')
      expect(consistency(drawn('{"data":{},"order":[]}', { drawings: undefined, drawingsOrder: undefined }))).toBe('ok')
      expect(consistency(drawn('', { drawings: {}, drawingsOrder: [] }))).toBe('ok')
    })

    it.each([
      ['少一张', JSON.stringify({ data: { img1: drawings.img1 }, order: ['img1', 'img2'] })],
      ['某张图的字段不同', JSON.stringify({ data: { ...drawings, img2: { drawingId: 'img2', source: '/api/assets/0199a2c4-1f2e-4a3b-8c4d-000000000000' } }, order: ['img1', 'img2'] })],
      ['深处的数字不同', JSON.stringify({ data: { ...drawings, img1: { ...drawings.img1, docTransform: { size: { width: 121, height: 80 } } } }, order: ['img1', 'img2'] })],
      ['先后不同', JSON.stringify({ data: drawings, order: ['img2', 'img1'] })],
      ['空串（等于没有图片），顶层却有', ''],
    ])('图片资源不一致：%s', (_case, data) => {
      expect(consistency(drawn(data))).toBe('resource-mismatch')
    })

    it('数组与对象不混同：data 里一张图是数组、另一边是同样内容的对象时不相等', () => {
      const top = { drawings: { a: { list: [1, 2] } }, drawingsOrder: ['a'] }
      expect(consistency(drawn(JSON.stringify({ data: { a: { list: { 0: 1, 1: 2 } } }, order: ['a'] }), top))).toBe('resource-mismatch')
      expect(consistency(drawn(JSON.stringify({ data: { a: { list: [1, 2] } }, order: ['a'] }), top))).toBe('ok')
    })
  })
})
