import { describe, expect, it } from 'vitest'
import { encodeCsv } from './encode-csv.ts'
import { parseCsv } from './parse-csv.ts'

const text = (value: string) => ({ text: value, kind: 'text' as const })
const number = (value: string) => ({ text: value, kind: 'number' as const })
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)

describe('CSV 导出：显示数据与字段级保护', () => {
  it('输出真实 UTF-8 BOM、CRLF 和转义，短行补齐', () => {
    const bytes = encodeCsv([[text('姓名'), text('引号"与,逗号'), text('两\n行')], [text('😀')]])
    expect([...bytes.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF])
    expect(decode(bytes)).toBe('\uFEFF"姓名","引号""与,逗号","两\n行"\r\n"😀","",""\r\n')
  })

  it.each(['=1+1', '+1', '-2', '@x', '＝1+1', '＋1', '－2', '＠x', '\t文字', '\r文字', '\n文字', '  =1+1', '\uFEFF=1+1', '\u00A0@x', '\v=1+1', '\u0001=1+1'])('文本 %j 在完整字段内加 TAB', (value) => {
    expect(decode(encodeCsv([[text(value)]]))).toBe(`\uFEFF"\t${value}"\r\n`)
  })

  it('危险文本的引号和分隔符仍在同一字段内', async () => {
    const output = encodeCsv([[text('=1+1",=2+2')]])
    expect(decode(output)).toBe('\uFEFF"\t=1+1"",=2+2"\r\n')
    expect((await parseCsv(output)).rows).toEqual([['\t=1+1",=2+2']])
  })

  it.each(['-12.5', '-1,234.50', '-5%', '-1.2e-5', '0', '2026-11-01', '(1,234.50)'])('数字显示 %j 不被统一前缀损坏', (value) => {
    expect(decode(encodeCsv([[number(value)]]))).toBe(`\uFEFF"${value}"\r\n`)
  })

  it.each(['=1+1', '-1+2', '+1', '-1;=2', '－1', '\t=1', ' -1'])('数字格式生成危险文字 %j 仍受保护', (value) => {
    expect(decode(encodeCsv([[number(value)]]))).toBe(`\uFEFF"\t${value}"\r\n`)
  })

  it('普通文字、前导零、日期、已有单引号和空格不被自行转换', () => {
    expect(decode(encodeCsv([[text('001'), text('2026-11-01'), text('\'=1'), text(' a '), text('')]]))).toBe('\uFEFF"001","2026-11-01","\'=1"," a ",""\r\n')
  })

  it.each([{ rows: [] }, { rows: [[]] }])('没有单元格的矩阵拒绝，不下载假成功文件', ({ rows }) => {
    expect(() => encodeCsv(rows)).toThrow(expect.objectContaining({ reason: 'empty' }))
  })

  it('行列和矩形上限约束导出，不只计算非空格', () => {
    expect(() => encodeCsv(Array.from({ length: 50_001 }, () => [text('')]))).toThrow(expect.objectContaining({ reason: 'rows' }))
    expect(() => encodeCsv([Array.from({ length: 1_025 }, () => text(''))])).toThrow(expect.objectContaining({ reason: 'columns' }))
    const rows = Array.from({ length: 1_001 }, () => [text('x')])
    rows[1_000] = Array.from({ length: 100 }, () => text(''))
    expect(() => encodeCsv(rows)).toThrow(expect.objectContaining({ reason: 'cells' }))
  })

  it('单字段限制和 NUL 拒绝在导出同样生效', () => {
    expect(() => encodeCsv([[text('x'.repeat(32_767))]])).not.toThrow()
    expect(() => encodeCsv([[text('x'.repeat(32_768))]])).toThrow(expect.objectContaining({ reason: 'field' }))
    expect(() => encodeCsv([[text('x\0y')]])).toThrow(expect.objectContaining({ reason: 'syntax' }))
  })

  it('保护前缀也计入字段上限，导出不能生成自身无法导入的超长字段', async () => {
    const allowed = encodeCsv([[text(`=${'x'.repeat(32_765)}`)]])
    expect((await parseCsv(allowed)).rows[0]?.[0]).toHaveLength(32_767)
    expect(() => encodeCsv([[text(`=${'x'.repeat(32_766)}`)]])).toThrow(expect.objectContaining({ reason: 'field' }))
  })

  it.each(['\uD800', '\uDC00', 'a\uD800b'])('孤立代理字符 %j 不得被 UTF-8 编码器静默替换', (value) => {
    expect(() => encodeCsv([[text(value)]])).toThrow(expect.objectContaining({ reason: 'encoding' }))
  })

  it('转义之后按实际 UTF-8 字节计上限，BOM 和 CRLF 都计入', () => {
    // 159 * (32767 + 4) + (32284 + 4) + 3 = 5242880。
    const rows = Array.from({ length: 159 }, () => [text('x'.repeat(32_767))])
    rows.push([text('x'.repeat(32_284))])
    expect(encodeCsv(rows).byteLength).toBe(5_242_880)
    rows[159] = [text('x'.repeat(32_285))]
    expect(() => encodeCsv(rows)).toThrow(expect.objectContaining({ reason: 'bytes' }))
    const quotes = Array.from({ length: 81 }, () => [text('"'.repeat(32_767))])
    expect(() => encodeCsv(quotes)).toThrow(expect.objectContaining({ reason: 'bytes' }))
    const multibyte = Array.from({ length: 54 }, () => [text('一'.repeat(32_767))])
    expect(() => encodeCsv(multibyte)).toThrow(expect.objectContaining({ reason: 'bytes' }))
  })
})
