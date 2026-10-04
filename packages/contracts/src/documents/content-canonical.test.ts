// 规范化内容的测试向量（M3-P3 设计 §3.2，规格写进 ADR-011）：客户端在 M4 要逐字节复现，这里的规范文字与 SHA-256 一改就失败。
// M0 的样本（testdata/，出自 spikes/m0）：sheet-all 的原文（S0，fixtures/sheet/sheet-all.json）与它在浏览器里打开再保存的结果
// （S1，e2e/results/v03/s1/chromium-sheet-sheet-all.json，三个浏览器逐字节相同）——差别全是空值等价与资源 data 里的键序（M0-P2 报告 §2.3）
import { describe, expect, it } from 'vitest'
import { canonicalContentText, canonicalContentTextOf, contentHashInput, SHEET_VIEW_STATE_FIELDS } from './content-canonical.ts'
import { sheetSnapshotFor } from './sheet-template.ts'
import M0_SHEET_ALL_S0 from './testdata/m0-sheet-all.s0.json' with { type: 'json' }
import M0_SHEET_ALL_S1 from './testdata/m0-sheet-all.s1.json' with { type: 'json' }

/** SHA-256 的十六进制（测试在 Node 里跑，用全局的 WebCrypto；contracts 本身不带哈希） */
async function sha256(bytes: Uint8Array): Promise<string> {
  const { subtle } = (globalThis as unknown as { crypto: { subtle: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> } } }).crypto
  return [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '')
    return true
  if (Array.isArray(value))
    return value.every(isEmptyValue)
  if (typeof value === 'object')
    return Object.values(value).every(isEmptyValue)
  return false
}

function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(pruneEmpty)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([, item]) => !isEmptyValue(item)).map(([key, item]) => [key, pruneEmpty(item)]))
  return value
}

/**
 * M0 原型的写法（spikes/m0/src/harness/content-compare.ts，空资源按 editor/testing/content-compare.ts 去掉）：递归地去掉空键，
 * 键用 Object.keys().sort() 排序之后经 Object.fromEntries 重建、JSON.stringify。重建的对象按 JS 的属性顺序写出，
 * 实际得到的就是"数组下标形式的键按数值升序在前，其余按 UTF-16 码元的字典序"
 */
function m0Canonical(text: string): string {
  const snapshot = JSON.parse(text) as { sheets?: Record<string, Record<string, unknown>>, resources?: { name: string, data: string }[] }
  for (const sheet of Object.values(snapshot.sheets ?? {})) {
    delete sheet.zoomRatio
    delete sheet.scrollTop
    delete sheet.scrollLeft
  }
  const resources = (snapshot.resources ?? []).map(resource => ({ name: resource.name, data: pruneEmpty(resource.data === '' ? null : JSON.parse(resource.data)) })).filter(resource => !isEmptyValue(resource.data)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return JSON.stringify({ ...snapshot, resources }, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      return item
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]]))
  })
}

const S0 = JSON.stringify(M0_SHEET_ALL_S0)
const S1 = JSON.stringify(M0_SHEET_ALL_S1)
const UNIT = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'

/** 一个最小的工作簿：每个用例在它上面改一处 */
function workbook(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'u', sheetOrder: ['s1'], sheets: { s1: { id: 's1', cellData: { 0: { 0: { v: 1 } } } } }, resources: [], ...overrides })
}

describe('键序（写死，客户端在 M4 逐字节复现）', () => {
  const KEYS = '{"resources":[],"styles":{"b":1,"10":1,"9":1,"a":1,"B":1,"_":1,"01":1,"4294967295":1,"4294967294":1,"":1,"\\uFFFF":1,"😀":1,"é":1,"-1":1,"1.0":1,"__proto__":1}}'

  it('规范的数组下标形式的键（0–4294967294）按数值升序在前，其余按 UTF-16 码元的字典序（不是码点的顺序：😀 在 U+FFFF 之前）', () => {
    expect(canonicalContentText(KEYS)).toBe('{"resources":[],"styles":{"9":1,"10":1,"4294967294":1,"":1,"-1":1,"01":1,"1.0":1,"4294967295":1,"B":1,"_":1,"__proto__":1,"a":1,"b":1,"é":1,"😀":1,"￿":1}}')
  })

  it('与 M0 原型的写法逐字节相同：样本、模板与键序的边界', () => {
    for (const text of [S0, S1, KEYS, sheetSnapshotFor(UNIT), workbook({ zoomRatio: 2, sheets: { s1: { zoomRatio: 3, scrollTop: 1, cellData: { 10: { 2: { v: 'x' } }, 9: {} } } } })])
      expect(canonicalContentText(text)).toBe(m0Canonical(text))
  })

  it('每一层的对象都排序，数组的顺序不变', () => {
    expect(canonicalContentText('{"z":[{"b":1,"a":2},[3,1]],"resources":[],"a":{"d":{"f":1,"e":2}}}')).toBe('{"a":{"d":{"e":2,"f":1}},"resources":[],"z":[{"a":2,"b":1},[3,1]]}')
  })
})

describe('视图状态', () => {
  it('去掉每张工作表的 zoomRatio、scrollTop、scrollLeft', () => {
    expect(SHEET_VIEW_STATE_FIELDS).toEqual(['zoomRatio', 'scrollTop', 'scrollLeft'])
    const text = workbook({ sheets: { s1: { name: '数据', zoomRatio: 1.5, scrollTop: 300, scrollLeft: 20 }, s2: { name: '汇总', zoomRatio: 1 } } })
    expect(canonicalContentText(text)).toBe('{"id":"u","resources":[],"sheetOrder":["s1"],"sheets":{"s1":{"name":"数据"},"s2":{"name":"汇总"}}}')
  })

  it('只改了缩放与滚动：内容相同（00 号计划书 §7.3）', () => {
    expect(canonicalContentText(workbook({ sheets: { s1: { zoomRatio: 2, scrollTop: 900, scrollLeft: 30, cellData: {} } } })))
      .toBe(canonicalContentText(workbook({ sheets: { s1: { cellData: {}, zoomRatio: 1, scrollTop: 0, scrollLeft: 0 } } })))
  })

  it('别处的同名键不动：顶层、单元格里与不是对象的工作表', () => {
    expect(canonicalContentText(workbook({ zoomRatio: 2, sheets: { s1: { cellData: { 0: { 0: { scrollTop: 1 } } } }, s2: 'x' } })))
      .toBe('{"id":"u","resources":[],"sheetOrder":["s1"],"sheets":{"s1":{"cellData":{"0":{"0":{"scrollTop":1}}}},"s2":"x"},"zoomRatio":2}')
  })
})

describe('资源', () => {
  it('深层为空的去掉："在而为空"与"不在"等价（空串、{}、{ 工作表: [] }、null、[]）', () => {
    const empties = [
      { name: 'SHEET_RANGE_PROTECTION_PLUGIN', data: '' },
      { name: 'SHEET_FILTER_PLUGIN', data: '{}' },
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: '{"sheet-1":[],"sheet-2":[]}' },
      { name: 'SHEET_NOTE_PLUGIN', data: 'null' },
      { name: 'SHEET_DRAWING_PLUGIN', data: '[]' },
      { name: 'SHEET_DEFINED_NAME_PLUGIN', data: '{"a":{"b":[{},[null,""]]}}' },
    ]
    const bare = canonicalContentText(workbook())
    expect(canonicalContentText(workbook({ resources: empties }))).toBe(bare)
    expect(bare).toContain('"resources":[]')
  })

  it('没有 resources、null 与空数组等价', () => {
    const { resources: _resources, ...rest } = JSON.parse(workbook()) as Record<string, unknown>
    expect(canonicalContentText(JSON.stringify(rest))).toBe(canonicalContentText(workbook()))
    expect(canonicalContentText(workbook({ resources: null }))).toBe(canonicalContentText(workbook()))
  })

  it('非空的：data 解析一次（里面的字符串不再解析），每一层的对象去掉取值深层为空的键，数组的项一个不少；写成 { data, name }，按名称排序', () => {
    const resources = [
      { name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{"ref":{"startRow":0},"cachedFilteredOut":[],"filterColumns":[{"colId":1,"extra":{}}]},"s2":{}}' },
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: '{"s2":[],"s1":[{"uid":"r1","formula1":"[]","ranges":[{},{"startRow":1}]}]}' },
    ]
    expect(canonicalContentText(workbook({ resources }))).toBe(
      '{"id":"u","resources":[{"data":{"s1":[{"formula1":"[]","ranges":[{},{"startRow":1}],"uid":"r1"}]},"name":"SHEET_DATA_VALIDATION_PLUGIN"},'
      + '{"data":{"s1":{"filterColumns":[{"colId":1}],"ref":{"startRow":0}}},"name":"SHEET_FILTER_PLUGIN"}],'
      + '"sheetOrder":["s1"],"sheets":{"s1":{"cellData":{"0":{"0":{"v":1}}},"id":"s1"}}}',
    )
  })

  it('名称按 UTF-16 码元排序（不按语言环境）；名称相同的保持原来的先后', () => {
    const resources = [{ name: 'b', data: '1' }, { name: 'B_2', data: '2' }, { name: 'B', data: '3' }, { name: 'b', data: '4' }]
    expect(canonicalContentText(workbook({ resources }))).toContain('"resources":[{"data":3,"name":"B"},{"data":2,"name":"B_2"},{"data":1,"name":"b"},{"data":4,"name":"b"}]')
  })

  it('不是 { name: 字符串, data: 字符串 } 的项原样排在后面；解析不了的 data 当字符串（服务端的检查先拒绝它们，只为结果确定）', () => {
    const resources = [{ name: 'z', data: 1 }, 'x', { name: 'b', data: 'not json' }, { name: 'a', data: '{"k":1}', id: 'extra' }]
    expect(canonicalContentText(workbook({ resources }))).toContain('"resources":[{"data":{"k":1},"name":"a"},{"data":"not json","name":"b"},{"data":1,"name":"z"},"x"]')
    expect(canonicalContentText(workbook({ resources: { name: 'a' } }))).toContain('"resources":{"name":"a"}')
  })
})

describe('以 JSON 文本为准', () => {
  it('空白、键的先后、转义的写法、数字的写法不影响；重复的键取后一个（JSON.parse 的语义）', () => {
    const plain = '{"id":"u","resources":[],"sheets":{"s1":{"cellData":{"0":{"0":{"v":1,"m":"é"}}}}}}'
    const variants = [
      '{ "sheets" : { "s1" : { "cellData" : { "0" : { "0" : { "m" : "\\u00e9" , "v" : 1.0 } } } } } , "id" : "u" , "resources" : [ ] }',
      '{"id":"x","resources":[],"sheets":{"s1":{"cellData":{"0":{"0":{"v":10e-1,"m":"é"}}}}},"id":"u"}',
    ]
    for (const variant of variants)
      expect(canonicalContentText(variant)).toBe(canonicalContentText(plain))
    expect(canonicalContentText('{"resources":[],"a":-0,"b":1e21,"c":0.1}')).toBe('{"a":0,"b":1e+21,"c":0.1,"resources":[]}')
  })

  it('__proto__ 是普通的键，不改原型', () => {
    expect(canonicalContentText('{"resources":[],"__proto__":{"x":1},"cell":{"__proto__":2}}')).toBe('{"__proto__":{"x":1},"cell":{"__proto__":2},"resources":[]}')
  })

  it('孤立的代理项写成 \\u 转义（规范文字是合法的 UTF-16，UTF-8 编码是确定的）；控制字符按 JSON.stringify 转义', () => {
    expect(canonicalContentText('{"resources":[],"s":"\\ud800x","t":"\\u0001\\n"}')).toBe('{"resources":[],"s":"\\ud800x","t":"\\u0001\\n"}')
  })

  it('不是合法的 JSON：抛出 JSON.parse 的 SyntaxError', () => {
    expect(() => canonicalContentText('{"id":')).toThrow(SyntaxError)
  })

  it('canonicalContentText 与对解析结果的 canonicalContentTextOf 相同；不改传入的值', () => {
    for (const text of [S0, S1, sheetSnapshotFor(UNIT), workbook({ sheets: { s1: { zoomRatio: 2 } }, resources: [{ name: 'a', data: '{"k":{"e":[]}}' }] })]) {
      const parsed = JSON.parse(text) as unknown
      expect(canonicalContentTextOf(parsed)).toBe(canonicalContentText(text))
      expect(JSON.stringify(parsed)).toBe(text)
    }
  })

  it('不是对象的快照原样写出（键照样排序）：任何 JSON 的值都不抛出', () => {
    expect(canonicalContentTextOf([{ b: 1, a: 2 }, null, 'x', 1.5, true])).toBe('[{"a":2,"b":1},null,"x",1.5,true]')
    expect(canonicalContentTextOf(null)).toBe('null')
  })

  it('很深的嵌套不爆栈（迭代地写；JSON.stringify 在几千层就抛 RangeError）：单元格里与资源的 data 里各 20 万层', () => {
    const depth = 200_000
    const deep = `${'['.repeat(depth)}1${']'.repeat(depth)}`
    const text = `{"resources":[{"name":"n","data":${JSON.stringify(deep)}}],"sheets":{"s1":{"cellData":${deep}}}}`
    expect(canonicalContentText(text)).toBe(`{"resources":[{"data":${deep},"name":"n"}],"sheets":{"s1":{"cellData":${deep}}}}`)
  })
})

describe('内容相同与不同', () => {
  it('M0 的 S0 与 S1（sheet-all）：打开再保存之后的差别全是空值等价与资源 data 里的键序，规范文字相同', () => {
    expect(S0).not.toBe(S1)
    expect(canonicalContentText(S0)).toBe(canonicalContentText(S1))
  })

  it('真实的修改：单元格的值、单元格里的空串（只有资源去掉空键）、工作表的顺序、资源里的规则', () => {
    const base = canonicalContentText(workbook())
    expect(canonicalContentText(workbook({ sheets: { s1: { id: 's1', cellData: { 0: { 0: { v: 2 } } } } } }))).not.toBe(base)
    expect(canonicalContentText(workbook({ sheets: { s1: { id: 's1', cellData: { 0: { 0: { v: 1, m: '' } } } } } }))).not.toBe(base)
    expect(canonicalContentText(workbook({ sheetOrder: ['s1', 's2'] }))).not.toBe(base)
    expect(canonicalContentText(workbook({ resources: [{ name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{"ref":{"startRow":0}}}' }] }))).not.toBe(base)
  })
})

describe('测试向量：规范文字的 UTF-8 字节的 SHA-256（服务端与页面各用自己的实现，结果要等于这里）', () => {
  it('UTF-8 字节', () => {
    expect([...contentHashInput('a€😀')]).toEqual([0x61, 0xE2, 0x82, 0xAC, 0xF0, 0x9F, 0x98, 0x80])
  })

  it('M0 的 sheet-all（S0 与 S1 同一个）', async () => {
    expect(await sha256(contentHashInput(canonicalContentText(S0)))).toBe('42418b745c57e5b0098bb9428fd5798270aa5468590bd6fe2769a7a86c0535d8')
    expect(await sha256(contentHashInput(canonicalContentText(S1)))).toBe('42418b745c57e5b0098bb9428fd5798270aa5468590bd6fe2769a7a86c0535d8')
  })

  it('新表格的模板（资源全是空的）', async () => {
    const canonical = canonicalContentText(sheetSnapshotFor(UNIT))
    expect(canonical).toBe(`{"appVersion":"1.0.1","id":"${UNIT}","locale":"zhCN","name":"","resources":[],"sheetOrder":["sheet-1"],"sheets":{"sheet-1":{"cellData":{},"columnCount":20,"columnData":{},"columnHeader":{"height":20,"hidden":0},"defaultColumnWidth":88,"defaultRowHeight":24,"freeze":{"startColumn":-1,"startRow":-1,"xSplit":0,"ySplit":0},"hidden":0,"id":"sheet-1","mergeData":[],"name":"工作表1","rightToLeft":0,"rowCount":1000,"rowData":{},"rowHeader":{"hidden":0,"width":46},"showGridlines":1,"tabColor":""}},"styles":{}}`)
    expect(await sha256(contentHashInput(canonical))).toBe('464561bca9771e3a2581ff288818c99d7d6701af932ce1abff8194c2af61a2ef')
  })
})
