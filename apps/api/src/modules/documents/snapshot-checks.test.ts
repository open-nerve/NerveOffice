import type { EntryCount } from './snapshot-checks.ts'
import { HYPERLINK_RANGE_TYPE, SHEET_TEMPLATE, sheetSnapshotFor, SNAPSHOT_MAX_DEPTH } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { embeddedJson, hasForeignImage, measureJsonText, PROFILE_SNAPSHOT_RULES, RESOURCE_DATA_DEPTH, SNAPSHOT_MAX_ENTRIES } from './snapshot-checks.ts'

const UNIT_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const ASSET = '/api/assets/0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const SHEET = PROFILE_SNAPSHOT_RULES['sheet@1']

function fresh(): EntryCount {
  return { entries: 0 }
}

/** 解析之后数出的元素（对象的键加数组的项）：与按文字数的结果对照 */
function parsedEntries(value: unknown): number {
  let entries = 0
  const pending = [value]
  for (let item = pending.pop(); item !== undefined || pending.length > 0; item = pending.pop()) {
    if (typeof item !== 'object' || item === null)
      continue
    const children: unknown[] = Object.values(item)
    entries += children.length
    pending.push(...children)
  }
  return entries
}

/** 最深的对象或数组在第 depth 层（最外层算第 1 层） */
function nestedArrays(depth: number): string {
  return `${'['.repeat(depth)}${']'.repeat(depth)}`
}

describe('按文字数嵌套与元素（measureJsonText）', () => {
  it(`嵌套最多 ${SNAPSHOT_MAX_DEPTH} 层：最外层的对象或数组算第 1 层`, () => {
    expect(measureJsonText(nestedArrays(SNAPSHOT_MAX_DEPTH), 1, fresh())).toBeUndefined()
    expect(measureJsonText(nestedArrays(SNAPSHOT_MAX_DEPTH + 1), 1, fresh())).toBe('depth')
    expect(measureJsonText(`{"a":${'{"b":'.repeat(SNAPSHOT_MAX_DEPTH - 1)}0${'}'.repeat(SNAPSHOT_MAX_DEPTH - 1)}}`, 1, fresh())).toBeUndefined()
    expect(measureJsonText(`{"a":${'{"b":'.repeat(SNAPSHOT_MAX_DEPTH)}0${'}'.repeat(SNAPSHOT_MAX_DEPTH)}}`, 1, fresh())).toBe('depth')
  })

  it('资源 data 从第 4 层起算：data 里最多再嵌套 61 层（与外层累加）', () => {
    expect(RESOURCE_DATA_DEPTH).toBe(4)
    expect(measureJsonText(nestedArrays(SNAPSHOT_MAX_DEPTH - RESOURCE_DATA_DEPTH + 1), RESOURCE_DATA_DEPTH, fresh())).toBeUndefined()
    expect(measureJsonText(nestedArrays(SNAPSHOT_MAX_DEPTH - RESOURCE_DATA_DEPTH + 2), RESOURCE_DATA_DEPTH, fresh())).toBe('depth')
  })

  it('字符串里的括号、逗号不算；转义的引号不结束字符串，转义的反斜杠之后的引号结束它', () => {
    const inString = `{"a":"${'[{,'.repeat(1_000)}","b":"\\"${'['.repeat(100)}","c":"\\\\"}`
    expect(JSON.parse(inString)).toBeTruthy()
    const count = fresh()
    expect(measureJsonText(inString, 1, count)).toBeUndefined()
    expect(count.entries).toBe(3)
    // "\\" 之后的字符串已经结束：后面的括号在字符串之外
    expect(measureJsonText(`["\\\\",${nestedArrays(SNAPSHOT_MAX_DEPTH)}]`, 1, fresh())).toBe('depth')
  })

  it('数出的元素与解析之后数出的相同：模板、M0 的样本、空的容器与空白', () => {
    for (const text of [
      sheetSnapshotFor(UNIT_ID),
      JSON.stringify(SHEET_TEMPLATE, undefined, 2),
      '{ "a" : [ ] , "b" : { } , "c" : [ 1 , [ ] , { "d" : null } ] , "e" : "x,y" }',
      '[]',
      '{}',
      '0',
      '"[1,2]"',
      '[[[[]]],{"":{"":[0]}}]',
    ]) {
      const count = fresh()
      expect(measureJsonText(text, 1, count), text).toBeUndefined()
      expect(count.entries, text).toBe(parsedEntries(JSON.parse(text)))
    }
  })

  it(`元素最多 ${SNAPSHOT_MAX_ENTRIES} 个：多一个就是 entries，几段文字累加`, () => {
    const zeros = (count: number): string => `[${Array.from({ length: count }).fill('0').join(',')}]`
    expect(measureJsonText(zeros(SNAPSHOT_MAX_ENTRIES), 1, fresh())).toBeUndefined()
    expect(measureJsonText(zeros(SNAPSHOT_MAX_ENTRIES + 1), 1, fresh())).toBe('entries')
    const count = fresh()
    expect(measureJsonText(zeros(SNAPSHOT_MAX_ENTRIES - 10), 1, count)).toBeUndefined()
    expect(measureJsonText(zeros(10), RESOURCE_DATA_DEPTH, count)).toBeUndefined()
    expect(measureJsonText('[0]', RESOURCE_DATA_DEPTH, count)).toBe('entries')
  })

  it('几十万层也不爆栈，数到超出就停下', () => {
    expect(measureJsonText(nestedArrays(300_000), 1, fresh())).toBe('depth')
    expect(measureJsonText(`"${'\\'.repeat(9)}`, 1, fresh())).toBeUndefined()
  })
})

describe('资源 data 里的 JSON（embeddedJson）', () => {
  function withResources(resources: unknown): unknown {
    return { ...JSON.parse(sheetSnapshotFor(UNIT_ID)) as object, resources }
  }

  it('每项资源的 data 先数、再解析；空串、不是字符串、不是对象的项与解析不了的不在结果里', () => {
    const count = fresh()
    const values = embeddedJson(withResources([
      { name: 'SHEET_NOTE_PLUGIN', data: '{"sheet-1":{"0":{"0":{"note":"x"}}}}' },
      { name: 'SHEET_FILTER_PLUGIN', data: '' },
      { name: 'SHEET_DEFINED_NAME_PLUGIN', data: 1 },
      'not-an-object',
      { name: 'SHEET_DRAWING_PLUGIN', data: '{not json' },
    ]), count)
    expect(values).toEqual([{ 'sheet-1': { 0: { 0: { note: 'x' } } } }])
    // 备注的 4 个，加上解析不了的那段按文字数出的 1 个（数在解析之前）
    expect(count.entries).toBe(5)
  })

  it('没有 resources、resources 不是数组时没有', () => {
    expect(embeddedJson({ id: UNIT_ID }, fresh())).toEqual([])
    expect(embeddedJson(withResources({ length: 1 }), fresh())).toEqual([])
    expect(embeddedJson('text', fresh())).toEqual([])
  })

  it('data 里的嵌套与外层累加：超出时给出 depth，不解析', () => {
    const fits = nestedArrays(SNAPSHOT_MAX_DEPTH - RESOURCE_DATA_DEPTH + 1)
    expect(embeddedJson(withResources([{ name: 'SHEET_NOTE_PLUGIN', data: fits }]), fresh())).toHaveLength(1)
    expect(embeddedJson(withResources([{ name: 'SHEET_NOTE_PLUGIN', data: `[${fits}]` }]), fresh())).toBe('depth')
    // 资源 data 里极深的嵌套（几十万层）：数到超出就停，不交给 JSON.parse
    expect(embeddedJson(withResources([{ name: 'SHEET_NOTE_PLUGIN', data: nestedArrays(300_000) }]), fresh())).toBe('depth')
  })

  it('data 里的元素与外层累加：合计超出时给出 entries', () => {
    const count: EntryCount = { entries: SNAPSHOT_MAX_ENTRIES - 2 }
    expect(embeddedJson(withResources([{ name: 'SHEET_NOTE_PLUGIN', data: '[0,0,0]' }]), count)).toBe('entries')
  })
})

describe('图片地址出现在哪里（hasForeignImage）', () => {
  it('名为 source 的字段都是相对的平台图片地址：通过', () => {
    expect(hasForeignImage([{ sheets: { s: { cellData: { 0: { 0: { p: { drawings: { d: { source: ASSET } } } } } } } } }])).toBe(false)
    expect(hasForeignImage([{ 'sheet-1': { data: { d: { source: ASSET, imageSourceType: 'URL' } } } }])).toBe(false)
  })

  it.each([
    ['data: 地址', 'data:image/png;base64,iVBORw0KGgo='],
    ['外站地址', 'https://example.com/a.png'],
    ['本站的绝对写法（服务端只认相对的）', `https://docs.example.com${ASSET}`],
    ['带查询参数', `${ASSET}?size=1`],
    ['大写的 uuid', ASSET.toUpperCase()],
    ['空串', ''],
    ['不是字符串：数字', 1],
    ['不是字符串：null', null],
    ['不是字符串：对象', { url: ASSET }],
  ])('%s：不通过', (_case, source) => {
    expect(hasForeignImage([{ a: [{ b: { source } }] }])).toBe(true)
  })

  it('任何深度、任何一段 JSON 里都找：单元格图片、工作表背景、资源 data 解析出的值、数组里', () => {
    expect(hasForeignImage([{ sheets: { s: { backgroundImage: { source: 'https://evil.example/bg.png' } } } }])).toBe(true)
    expect(hasForeignImage([{ ok: true }, { 'sheet-1': { data: { d: { source: '/fixtures-assets/a.png' } } } }])).toBe(true)
    expect(hasForeignImage([[[[{ source: 'x' }]]]])).toBe(true)
    expect(hasForeignImage([JSON.parse('{"__proto__":{"source":"https://evil.example/a.png"}}') as unknown])).toBe(true)
  })

  it('只看名为 source 的字段：别的名字、值里的地址都不管', () => {
    expect(hasForeignImage([{ imageSource: 'https://example.com/a.png', note: 'source', url: 'data:x' }])).toBe(false)
    expect(hasForeignImage([['source', { sources: 'x' }]])).toBe(false)
  })
})

describe('工作簿的结构（sheet@1）', () => {
  const template = (): Record<string, unknown> => JSON.parse(sheetSnapshotFor(UNIT_ID)) as Record<string, unknown>

  it('模板通过，给出 unitId', () => {
    expect(SHEET.structure(template())?.unitId).toBe(UNIT_ID)
  })

  it('不要求每张表都在 sheetOrder 里、sheetOrder 不重复、表的 id 等于键（没有证据说 SDK 写出的都满足）；没有表也可以', () => {
    expect(SHEET.structure({ ...template(), sheetOrder: [] })).toBeDefined()
    expect(SHEET.structure({ ...template(), sheetOrder: ['sheet-1', 'sheet-1'] })).toBeDefined()
    expect(SHEET.structure({ ...template(), sheets: { 'sheet-1': { id: 'other' } } })).toBeDefined()
    expect(SHEET.structure({ id: UNIT_ID, sheetOrder: [], sheets: {} })).toBeDefined()
  })

  it.each([
    ['顶层是数组', []],
    ['顶层是 null', null],
    ['顶层是字符串', 'x'],
    ['没有 id', { sheetOrder: [], sheets: {} }],
    ['id 不是字符串', { id: 1, sheetOrder: [], sheets: {} }],
    ['id 为空', { id: '', sheetOrder: [], sheets: {} }],
    ['没有 sheets', { id: UNIT_ID, sheetOrder: [] }],
    ['sheets 是数组', { id: UNIT_ID, sheetOrder: [], sheets: [] }],
    ['sheets 是 null', { id: UNIT_ID, sheetOrder: [], sheets: null }],
    ['某张表是数组', { id: UNIT_ID, sheetOrder: ['a'], sheets: { a: [] } }],
    ['某张表是 null', { id: UNIT_ID, sheetOrder: [], sheets: { a: null } }],
    ['某张表是字符串', { id: UNIT_ID, sheetOrder: [], sheets: { a: 'x' } }],
    ['没有 sheetOrder', { id: UNIT_ID, sheets: {} }],
    ['sheetOrder 是对象', { id: UNIT_ID, sheetOrder: {}, sheets: {} }],
    ['sheetOrder 里有不是字符串的项', { id: UNIT_ID, sheetOrder: [1], sheets: { 1: {} } }],
    ['sheetOrder 里有 sheets 没有的表', { id: UNIT_ID, sheetOrder: ['a', 'b'], sheets: { a: {} } }],
    ['sheetOrder 里的项只是原型上的名字', { id: UNIT_ID, sheetOrder: ['toString'], sheets: {} }],
  ])('%s：不通过（structure）', (_case, snapshot) => {
    expect(SHEET.structure(snapshot)).toBeUndefined()
  })
})

describe('工作簿里的链接（sheet@1）', () => {
  function cell(url: unknown, rangeId: unknown = 'r1'): unknown {
    return { v: 'x', p: { body: { dataStream: 'link\r\n', customRanges: [{ startIndex: 0, endIndex: 3, rangeId, rangeType: HYPERLINK_RANGE_TYPE, properties: { url } }] } } }
  }

  function workbook(sheets: Record<string, unknown>): Record<string, unknown> {
    return { id: UNIT_ID, sheetOrder: [], sheets }
  }

  function links(snapshot: Record<string, unknown>): string {
    const checked = SHEET.structure(snapshot)
    if (checked === undefined)
      throw new Error('结构不对')
    const check = SHEET.links(checked)
    return check.ok ? 'ok' : check.rule
  }

  it('规范写法的链接通过；没有单元格、没有富文本、别的种类的区间都没事', () => {
    expect(links(workbook({ s: { cellData: { 0: { 0: cell('https://example.com/') } } } }))).toBe('ok')
    expect(links(workbook({ s: { cellData: {} }, t: {} }))).toBe('ok')
    expect(links(workbook({ s: { cellData: { 0: { 0: { v: 1 }, 1: 'x', 2: null } } } }))).toBe('ok')
    expect(links(workbook({ s: { cellData: { 0: { 0: { p: { body: { customRanges: [{ rangeType: 1, rangeId: '!!' }] } } } } } } }))).toBe('ok')
  })

  it('每一条链接规则经单元格报出：地址不是规范写法、rangeId 不合写法、区间看不懂', () => {
    expect(links(workbook({ s: { cellData: { 0: { 0: cell('https://example.com') } } } }))).toBe('link-address')
    expect(links(workbook({ s: { cellData: { 0: { 0: cell('javascript:alert(1)') } } } }))).toBe('link-address')
    expect(links(workbook({ s: { cellData: { 0: { 0: cell('https://example.com/', 'bad id') } } } }))).toBe('link-range-id')
    expect(links(workbook({ s: { cellData: { 0: { 0: { p: { body: { customRanges: 'x' } } } } } } }))).toBe('link-structure')
    expect(links(workbook({ s: { cellData: { 0: { 0: cell(42) } } } }))).toBe('link-structure')
  })

  it('扫描每张表（不只 sheetOrder 里的）、每一行、每个单元格；行与单元格的容器是数组也照读（SDK 按下标读得到）', () => {
    expect(links({ id: UNIT_ID, sheetOrder: ['a'], sheets: { a: {}, hidden: { cellData: { 9: { 9: cell('https://x.example') } } } } })).toBe('link-address')
    expect(links(workbook({ s: { cellData: [[undefined, cell('https://x.example')]] } }))).toBe('link-address')
    expect(links(workbook({ s: { cellData: { 0: [cell('https://x.example')] } } }))).toBe('link-address')
    expect(links(workbook({ s: { cellData: { 0: { 0: cell('https://example.com/') }, 5: { 7: cell('https://x.example') } } } }))).toBe('link-address')
  })

  it('cellData 不是对象或数组：没有单元格', () => {
    expect(links(workbook({ s: { cellData: 'x' } }))).toBe('ok')
    expect(links(workbook({ s: { cellData: 1 } }))).toBe('ok')
  })
})
