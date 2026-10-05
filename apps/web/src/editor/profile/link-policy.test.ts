import type { FUniver } from '@univerjs/core/facade'
import type { CellWriteEvent } from './link-policy.ts'
import { checkCellLinks, HYPERLINK_RANGE_TYPE, normalizeCellLinks } from '@nerve-office/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CELL_LINK_PROTOCOL } from '../internal-api/index.ts'
import { formulaParagraphId, formulaRangeId, installLinkPolicy, rewriteCellWrite } from './link-policy.ts'

// 数出改写器把哪些单元格交给了 normalizeCellLinks（只改写带链接的单元格），行为照旧
vi.mock('@nerve-office/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nerve-office/contracts')>()
  return { ...actual, normalizeCellLinks: vi.fn(actual.normalizeCellLinks) }
})

beforeEach(() => {
  vi.mocked(normalizeCellLinks).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const MUTATION = 'sheet.mutation.set-range-values'
/** 公式结果写回时的执行选项（sheets 的 calculate-result-apply.controller.ts） */
const FORMULA_RESULT = { onlyLocal: true, fromFormula: true, applyFormulaCalculationResult: true }

type Json = Record<string, unknown>

function link(url: unknown, overrides: Json = {}): Json {
  return { startIndex: 0, endIndex: 3, rangeId: 'RgaJjD2xfh8RCJiDoaYN8', rangeType: HYPERLINK_RANGE_TYPE, properties: { url }, ...overrides }
}

// ---- P3 设计前的探针（探索 B）与 S2 的探针在三个浏览器里录下的单元格（1.0.1）：各条路径写出的 p 的形状 ----

/** 键入网址、编辑栏里键入（sheets-hyper-link 的写入拦截器）：v、t 与 3 个键的 p */
function typed(text: string, url: string): Json {
  return { v: text, t: 1, p: { id: 'd', body: { dataStream: `${text}\r\n`, customRanges: [link(url, { endIndex: text.length - 1 })] }, documentStyle: {} } }
}

/** 选中单元格粘贴纯文本（sheets-ui 的剪贴板）：没有 v，p 是完整的文档快照（13 个键） */
function pastedPlain(text: string): Json {
  return {
    p: {
      id: 'd',
      locale: 'zhCN',
      title: '',
      tableSource: {},
      drawings: {},
      drawingsOrder: [],
      headers: {},
      footers: {},
      notes: {},
      noteSettings: {},
      body: { dataStream: `${text}\r\n`, customRanges: [link(text, { endIndex: text.length - 1, rangeId: 'ynlvp_qla6HRirbZWKmiB' })], paragraphs: [{ startIndex: text.length }] },
      documentStyle: {},
      settings: {},
    },
  }
}

/** 单元格编辑器里粘贴（core 的 fromPlainText）：p 有 8 个键；两行时链接只覆盖第二段，地址却是整段文字（带换行） */
function cellEditorPaste(first: string, second: string): Json {
  const dataStream = `${first}\r${second}\r\n`
  const start = first.length + 1
  return {
    p: {
      id: 'd',
      body: { dataStream, customRanges: [link(`${first}\n${second}`, { startIndex: start, endIndex: start + second.length - 1, rangeId: '__-TKESMJGGYRu_xwYnkr' })] },
      drawings: {},
      drawingsOrder: [],
      footers: {},
      headers: {},
      tableSource: {},
      documentStyle: {},
    },
  }
}

/** 粘贴带 <a> 的 HTML（sheets-ui 的 html-to-usm）：v 是链接文字，地址是 HTMLAnchorElement.href（相对地址原样），rangeId 取 data-rangeid */
function pastedHtml(text: string, url: string, rangeId = 'hucfRGeowQk43aTxBrpxg'): Json {
  return { v: text, t: 1, p: { ...(pastedPlain(text).p as Json), body: { dataStream: `${text}\r\n`, customRanges: [link(url, { endIndex: text.length - 1, rangeId })] } } }
}

/** HYPERLINK() 的结果（S2 的探针）：f 与 5 个键的 p，没有 v；rangeId 与 paragraphId 每次计算都是随机的 */
function formulaResult(label: string, url: string, random: { rangeId: string, paragraphId: string }): Json {
  return {
    f: `=HYPERLINK("${url}","${label}")`,
    p: {
      id: 'd',
      documentStyle: {},
      drawings: {},
      drawingsOrder: [],
      body: {
        dataStream: `${label}\r\n`,
        customBlocks: [],
        customRanges: [{ rangeType: HYPERLINK_RANGE_TYPE, rangeId: random.rangeId, properties: { url }, startIndex: 0, endIndex: label.length - 1 }],
        paragraphs: [{ startIndex: label.length, paragraphId: random.paragraphId }],
        textRuns: [],
        tables: [],
        sectionBreaks: [],
        customDecorations: [],
      },
    },
  }
}

function write(cellValue: unknown, options?: Json): { readonly event: CellWriteEvent, readonly params: Json } {
  const params = { unitId: 'unit-1', subUnitId: 'sheet-1', cellValue }
  return { event: { id: MUTATION, params, options }, params }
}

function rangesOf(cell: unknown): Json[] {
  return ((cell as { p: { body: { customRanges: Json[] } } }).p.body.customRanges)
}

function urlsOf(cell: unknown): unknown[] {
  return rangesOf(cell).filter(range => range.rangeType === HYPERLINK_RANGE_TYPE).map(range => (range.properties as Json).url)
}

function noReport(): (error: unknown) => void {
  return vi.fn((error: unknown) => {
    throw new Error(`不该报告错误：${String(error)}`)
  })
}

describe('写入之前改写单元格里的链接（M3-P3 设计 §3.6，DEF-021）', () => {
  it('内部约定：写单元格的 mutation、链接区间的种类与 contracts 一致、公式结果的执行选项', () => {
    expect(CELL_LINK_PROTOCOL.setRangeValuesMutationId).toBe(MUTATION)
    // 服务端的 checkCellLinks 与页面的 normalizeCellLinks 按 contracts 的常量认链接：它必须等于 SDK 的 CustomRangeType.HYPERLINK
    expect(CELL_LINK_PROTOCOL.hyperlinkRangeType).toBe(HYPERLINK_RANGE_TYPE)
    expect(CELL_LINK_PROTOCOL.fromFormulaOption).toBe('fromFormula')
  })

  it('各条路径写出的单元格改成规范写法、不合法的去掉链接；文字（v、正文）与别的键不变，返回改写过的单元格数', () => {
    const cells = {
      0: { 0: typed('example.com', 'https://example.com'), 1: typed('user@example.com', 'mailto://user@example.com'), 2: typed('ftp://example.com/x', 'ftp://example.com/x') },
      1: { 0: pastedPlain('example.org'), 1: pastedPlain('https://Paste.Example/p?q=1') },
      2: { 0: cellEditorPaste('first line', 'https://ce-multi.example') },
      3: { 0: pastedHtml('rel', '/relative/path x?y=1#h'), 1: pastedHtml('nos', 'relative-no-slash'), 2: pastedHtml('abs', 'https://html.example/a%20b', '"><img src=x>') },
    }
    const before = structuredClone(cells)
    const { event, params } = write(cells)
    expect(rewriteCellWrite(event, noReport())).toBe(9)
    expect(params.cellValue).toBe(cells)
    expect(urlsOf(cells[0][0])).toEqual(['https://example.com/'])
    expect(urlsOf(cells[0][1])).toEqual(['mailto:user@example.com'])
    expect(urlsOf(cells[0][2])).toEqual([])
    expect(urlsOf(cells[1][0])).toEqual([])
    expect(urlsOf(cells[1][1])).toEqual(['https://paste.example/p?q=1'])
    // 链接文字本身是合法的绝对地址：改用这段文字
    expect(urlsOf(cells[2][0])).toEqual(['https://ce-multi.example/'])
    expect(urlsOf(cells[3][0])).toEqual(['/relative/path%20x?y=1#h'])
    expect(urlsOf(cells[3][1])).toEqual([])
    // data-rangeid 带来的不合写法的 rangeId 换掉
    expect(rangesOf(cells[3][2])[0]?.rangeId).toBe('link-0')
    // 只动了链接：去掉 customRanges 之后与改写之前相同
    const withoutRanges = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item: unknown) => key === 'customRanges' ? undefined : item))
    expect(withoutRanges(cells)).toEqual(withoutRanges(before))
    for (const row of Object.values(cells)) {
      for (const cell of Object.values(row))
        expect(checkCellLinks(cell.p), JSON.stringify(cell)).toEqual({ ok: true })
    }
  })

  it('只改写带链接的单元格：普通的值、公式、样式、没有 customRanges 的富文本都不交给 normalizeCellLinks；已经是规范写法的不换对象', () => {
    const canonical = typed('https://example.com/', 'https://example.com/')
    const canonicalRanges = rangesOf(canonical)
    const cells: Record<number, Record<number, unknown>> = {
      0: { 0: { v: 1, t: 2 }, 1: { f: '=A1+1' }, 2: { s: 'style-1' }, 3: null, 4: { p: { id: 'd', body: { dataStream: 'x\r\n' } } } },
      1: { 0: canonical, 1: { p: null }, 2: { p: { body: null } }, 3: 'not a cell' },
    }
    const { event } = write(cells)
    expect(rewriteCellWrite(event, noReport())).toBe(0)
    expect(vi.mocked(normalizeCellLinks)).toHaveBeenCalledTimes(1)
    expect(rangesOf(canonical)).toBe(canonicalRanges)
  })

  it('大范围的写入只看一眼每个单元格：2 万格里只有带链接的 2 格交给 normalizeCellLinks', () => {
    const cells: Record<number, Record<number, unknown>> = {}
    for (let row = 0; row < 1000; row += 1)
      cells[row] = Object.fromEntries(Array.from({ length: 20 }, (_, column) => [column, { v: row * 20 + column, t: 2 }]))
    cells[500]![3] = typed('example.com', 'https://example.com')
    cells[999]![19] = pastedPlain('example.org')
    const { event } = write(cells)
    expect(rewriteCellWrite(event, noReport())).toBe(2)
    expect(vi.mocked(normalizeCellLinks)).toHaveBeenCalledTimes(2)
  })

  it('只处理写单元格的 mutation：别的命令（同样形状的参数）、没有 cellValue 或清空（null）的写入什么也不做', () => {
    for (const id of ['sheet.command.set-range-values', 'doc.command.inner-paste', 'sheet.mutation.set-range-values-x', 'sheets.mutation.update-rich-hyper-link']) {
      const cell = typed('example.com', 'https://example.com')
      expect(rewriteCellWrite({ id, params: { cellValue: { 0: { 0: cell } } } }, noReport()), id).toBe(0)
      expect(urlsOf(cell)).toEqual(['https://example.com'])
    }
    for (const params of [undefined, null, 'x', 1, [], {}, { cellValue: null }, { cellValue: 'x' }, { cellValue: { 0: null, 1: 'x' } }])
      expect(rewriteCellWrite({ id: MUTATION, params }, noReport()), JSON.stringify(params)).toBe(0)
    expect(vi.mocked(normalizeCellLinks)).not.toHaveBeenCalled()
  })

  it('数组形式的 cellValue 同样按下标遍历', () => {
    const cell = typed('example.com', 'https://example.com')
    expect(rewriteCellWrite({ id: MUTATION, params: { cellValue: [[cell]] } }, noReport())).toBe(1)
    expect(urlsOf(cell)).toEqual(['https://example.com/'])
  })

  it('撤销与重做重放的是改写过的参数：再经过一次什么也不改（返回 0，对象不换）', () => {
    const cells = { 0: { 0: typed('example.com', 'https://example.com'), 1: pastedHtml('x', 'https://x.example', 'bad id') } }
    const { event } = write(cells)
    expect(rewriteCellWrite(event, noReport())).toBe(2)
    const settled = JSON.stringify(cells)
    const ranges = rangesOf(cells[0][0])
    expect(rewriteCellWrite(event, noReport())).toBe(0)
    expect(JSON.stringify(cells)).toBe(settled)
    expect(rangesOf(cells[0][0])).toBe(ranges)
  })
})

describe('公式的结果（执行选项带 fromFormula）：rangeId 与段落 id 由位置与序号确定，重算不改变内容', () => {
  it('确定的写法：formula-<行>-<列>-<序号>、para_formula-<行>-<列>-<序号>，合服务端的 rangeId 写法', () => {
    expect(formulaRangeId('12', '3', 0)).toBe('formula-12-3-0')
    expect(formulaParagraphId('12', '3', 1)).toBe('para_formula-12-3-1')
    expect(formulaRangeId('999999999', '99999', 99)).toMatch(/^[\w-]{1,64}$/)
  })

  it('同一个公式两次计算（SDK 给的随机值不同）改写之后完全相同；地址改成规范写法', () => {
    const first = formulaResult('ok', 'https://Formula.Example', { rangeId: 'L4XcGTrhFvdmfmPYQAUi4', paragraphId: 'para_4NbFlG-bCCig' })
    const second = formulaResult('ok', 'https://Formula.Example', { rangeId: 'Pf4_-3fTlEzEpF_usGFvt', paragraphId: 'para_PQxtLv9Ji2To' })
    for (const cell of [first, second])
      expect(rewriteCellWrite(write({ 7: { 2: cell } }, FORMULA_RESULT).event, noReport())).toBe(1)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(rangesOf(first)).toEqual([expect.objectContaining({ rangeId: 'formula-7-2-0', properties: { url: 'https://formula.example/' } })])
    expect((first.p as { body: { paragraphs: unknown[] } }).body.paragraphs).toEqual([{ startIndex: 2, paragraphId: 'para_formula-7-2-0' }])
    expect(checkCellLinks(first.p)).toEqual({ ok: true })
  })

  it('不合法的地址去掉链接、文字保留，段落 id 照样确定；内部锚点原样', () => {
    const bad = formulaResult('bad', 'other.invalid-tld-x', { rangeId: '1ab-9Sp0ZoTd2TgZyr0cP', paragraphId: 'para_02LSo4hmXKQw' })
    const anchor = formulaResult('jump', '#gid=sheet-1&range=A1', { rangeId: '4BVBDgVunD_j6ZclQ7SjW', paragraphId: 'para_I69NpzDBggc7' })
    expect(rewriteCellWrite(write({ 0: { 0: bad, 1: anchor } }, FORMULA_RESULT).event, noReport())).toBe(2)
    expect(rangesOf(bad)).toEqual([])
    expect((bad.p as { body: { dataStream: string, paragraphs: Json[] } }).body).toMatchObject({ dataStream: 'bad\r\n', paragraphs: [{ paragraphId: 'para_formula-0-0-0' }] })
    expect(rangesOf(anchor)).toEqual([expect.objectContaining({ rangeId: 'formula-0-1-0', properties: { url: '#gid=sheet-1&range=A1' } })])
  })

  it('序号只数链接：别的种类的区间原样保留；normalizeCellLinks 换上的 link-<下标> 也换成确定的值；没有 paragraphId 的段落不加', () => {
    const mention = { startIndex: 0, endIndex: 0, rangeId: 'mention-1', rangeType: 6, properties: {} }
    const cell = {
      p: {
        id: 'd',
        body: {
          dataStream: 'ab\rcd\r\n',
          customRanges: [link('https://a.example', { rangeId: 'bad id', endIndex: 0 }), mention, link('https://b.example', { startIndex: 3, endIndex: 4 })],
          paragraphs: [{ startIndex: 2, paragraphId: 'para_aaaaaaaaaaaa' }, { startIndex: 5 }],
        },
      },
    }
    expect(rewriteCellWrite(write({ 4: { 5: cell } }, FORMULA_RESULT).event, noReport())).toBe(1)
    expect(rangesOf(cell).map(range => range.rangeId)).toEqual(['formula-4-5-0', 'mention-1', 'formula-4-5-1'])
    expect(rangesOf(cell)[1]).toBe(mention)
    expect(cell.p.body.paragraphs).toEqual([{ startIndex: 2, paragraphId: 'para_formula-4-5-0' }, { startIndex: 5 }])
  })

  it('不带 fromFormula 的写入不换合写法的 rangeId 与段落 id：用户写进来的那一份就是存下的', () => {
    const cell = formulaResult('ok', 'https://formula.example/', { rangeId: 'L4XcGTrhFvdmfmPYQAUi4', paragraphId: 'para_4NbFlG-bCCig' })
    expect(rewriteCellWrite(write({ 0: { 0: cell } }, { onlyLocal: true }).event, noReport())).toBe(0)
    expect(rangesOf(cell)[0]?.rangeId).toBe('L4XcGTrhFvdmfmPYQAUi4')
    expect(JSON.stringify(cell)).toContain('para_4NbFlG-bCCig')
  })

  it('公式的结果没有链接也有富文本时同样确定段落 id；没有富文本的结果（普通的值）不看', () => {
    const plain = { p: { id: 'd', body: { dataStream: 'x\r\n', paragraphs: [{ startIndex: 1, paragraphId: 'para_random00000' }] } } }
    expect(rewriteCellWrite(write({ 0: { 0: plain, 1: { v: 2, t: 2 } } }, FORMULA_RESULT).event, noReport())).toBe(1)
    expect(plain.p.body.paragraphs).toEqual([{ startIndex: 1, paragraphId: 'para_formula-0-0-0' }])
    expect(vi.mocked(normalizeCellLinks)).not.toHaveBeenCalled()
  })

  it('行号、列号不是整数的写法时不换标识（拼不出合规的 rangeId），链接照样改写', () => {
    const cell = formulaResult('ok', 'https://Formula.Example', { rangeId: 'L4XcGTrhFvdmfmPYQAUi4', paragraphId: 'para_4NbFlG-bCCig' })
    expect(rewriteCellWrite(write({ 'a b': { 0: cell } }, FORMULA_RESULT).event, noReport())).toBe(1)
    expect(rangesOf(cell)[0]).toMatchObject({ rangeId: 'L4XcGTrhFvdmfmPYQAUi4', properties: { url: 'https://formula.example/' } })
  })

  it('重算之后再写一次确定的值：已经是确定的值时什么也不改', () => {
    const cell = formulaResult('ok', 'https://formula.example/', { rangeId: 'r', paragraphId: 'para_x' })
    const { event } = write({ 1: { 1: cell } }, FORMULA_RESULT)
    expect(rewriteCellWrite(event, noReport())).toBe(1)
    const ranges = rangesOf(cell)
    expect(rewriteCellWrite(event, noReport())).toBe(0)
    expect(rangesOf(cell)).toBe(ranges)
  })
})

describe('绝不抛出（Facade 派发执行前事件没有 try/catch）', () => {
  /** 读任何属性都抛错的对象 */
  function hostile(): unknown {
    return new Proxy({}, {
      get: () => {
        throw new Error('读不出来')
      },
      ownKeys: () => {
        throw new Error('列不出来')
      },
    })
  }

  it('参数本身读不出来：不抛出，报告一次，返回 0', () => {
    const report = vi.fn()
    expect(rewriteCellWrite({ id: MUTATION, params: hostile() }, report)).toBe(0)
    expect(rewriteCellWrite({ id: MUTATION, params: { cellValue: hostile() } }, report)).toBe(0)
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('一个单元格读不出来、一个冻结了：各报告一次，别的单元格照常改写', () => {
    const report = vi.fn()
    const frozen = typed('example.com', 'https://example.com')
    Object.freeze((frozen.p as Json).body)
    const fine = typed('example.com', 'https://example.com')
    const { event } = write({ 0: { 0: hostile(), 1: frozen, 2: fine } })
    expect(rewriteCellWrite(event, report)).toBe(1)
    expect(report).toHaveBeenCalledTimes(2)
    expect(String((report.mock.calls[0]?.[0] as Error).message)).toContain('（0，0）')
    expect(urlsOf(frozen)).toEqual(['https://example.com'])
    expect(urlsOf(fine)).toEqual(['https://example.com/'])
  })

  it('改写到一半出了意外（链接的属性读不出来）：去掉这个单元格的链接，别的种类的区间留着', () => {
    const report = vi.fn()
    const mention = { startIndex: 0, endIndex: 0, rangeId: 'm', rangeType: 6, properties: {} }
    const broken = { ...link(''), properties: undefined }
    Object.defineProperty(broken, 'properties', {
      get: () => {
        throw new Error('读不出来')
      },
    })
    const cell = { v: 'ab', p: { body: { dataStream: 'ab\r\n', customRanges: [mention, broken] } } }
    expect(rewriteCellWrite(write({ 0: { 0: cell } }).event, report)).toBe(0)
    expect(cell.p.body.customRanges).toEqual([mention])
    expect(report).toHaveBeenCalledOnce()
  })

  it('报告本身抛出也不抛出', () => {
    const report = vi.fn(() => {
      throw new Error('报告出错')
    })
    expect(() => rewriteCellWrite({ id: MUTATION, params: hostile() }, report)).not.toThrow()
    expect(report).toHaveBeenCalledOnce()
  })
})

describe('装上改写器（installLinkPolicy）', () => {
  /** 只实现 addEvent 与 Event.BeforeCommandExecute 的假 Facade：记下订阅者，由测试模拟 SDK 派发事件 */
  function fakeFacade() {
    const listeners = new Set<(event: CellWriteEvent) => void>()
    const api = {
      Event: { BeforeCommandExecute: 'BeforeCommandExecute' },
      addEvent: vi.fn((name: string, listener: (event: CellWriteEvent) => void) => {
        expect(name).toBe('BeforeCommandExecute')
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      }),
    }
    const fire = (event: CellWriteEvent): void => {
      for (const listener of listeners)
        listener(event)
    }
    return { api: api as unknown as FUniver, fire, listeners }
  }

  it('订阅执行前事件，就地改写事件交出的参数（同一个对象）；卸下之后不再改写', () => {
    const facade = fakeFacade()
    const installed = installLinkPolicy(facade.api, noReport())
    const cell = typed('example.com', 'https://example.com')
    const { event, params } = write({ 0: { 0: cell } })
    facade.fire(event)
    expect(event.params).toBe(params)
    expect(urlsOf(cell)).toEqual(['https://example.com/'])

    installed.dispose()
    expect(facade.listeners.size).toBe(0)
    const later = typed('example.com', 'https://example.com')
    facade.fire(write({ 0: { 0: later } }).event)
    expect(urlsOf(later)).toEqual(['https://example.com'])
  })

  it('默认把意外交给浏览器的错误报告（reportError），事件照常派发完', () => {
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    const facade = fakeFacade()
    installLinkPolicy(facade.api)
    expect(() => facade.fire({ id: MUTATION, params: { cellValue: new Proxy({}, {
      ownKeys: () => {
        throw new Error('列不出来')
      },
    }) } })).not.toThrow()
    expect(reported).toHaveBeenCalledOnce()
  })
})
