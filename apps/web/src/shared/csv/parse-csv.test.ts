import { describe, expect, it } from 'vitest'
import { CsvError } from './csv-format.ts'
import { parseCsv } from './parse-csv.ts'

const utf8 = (text: string) => new TextEncoder().encode(text)

describe('CSV 解析：保留字段，只交付完整矩阵', () => {
  it('逗号、转义引号和字段内换行不丢字', async () => {
    expect(await parseCsv(utf8('a,"b,b","c""d"\r\n一,"二\n三",'))).toEqual({
      rows: [['a', 'b,b', 'c"d'], ['一', '二\n三', '']],
      rowCount: 2,
      columnCount: 3,
    })
  })

  it('UTF-8 BOM、中文和非 BMP 字符不当作数据损坏', async () => {
    expect((await parseCsv(utf8('\uFEFF姓名,内容\n小明,😀'))).rows).toEqual([['姓名', '内容'], ['小明', '😀']])
  })

  it.each(['\r\n', '\n', '\r'])('支持 %j 记录分隔，末尾换行不多一行', async (newline) => {
    expect((await parseCsv(utf8(` a ,${newline}${newline}""${newline}`))).rows).toEqual([[' a ', ''], ['', ''], ['', '']])
  })

  it('保留引号内 CRLF、首尾空白与尾逗号，短行补空字段', async () => {
    expect((await parseCsv(utf8('"a\r\nb",  c  ,\nx'))).rows).toEqual([['a\r\nb', '  c  ', ''], ['x', '', '']])
  })

  it('显式空字段和空白行可表示空单元格', async () => {
    expect((await parseCsv(utf8('""'))).rows).toEqual([['']])
    expect((await parseCsv(utf8('\n'))).rows).toEqual([['']])
    expect((await parseCsv(utf8(','))).rows).toEqual([['', '']])
  })

  it.each(['', '\uFEFF'])('空文件 %j 明确拒绝', async (input) => {
    await expect(parseCsv(utf8(input))).rejects.toMatchObject({ reason: 'empty' })
  })

  it.each(['"abc', 'a"b', '"a"b', '"a" ', 'a,\0', '"\0"'])('不修复错误语法 %j', async (input) => {
    await expect(parseCsv(utf8(input))).rejects.toMatchObject({ reason: 'syntax' })
  })

  it.each(['08', '0B', '0C', '0E', '15', '1A', '1D', '1E', '1F'])('文档流的结构字符 U+00%s 在导入时拒绝：进了文字格，编辑时会被 SDK 当成结构标记而出错（审查疑点 Q-12）', async (hex) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16))
    for (const input of [`a${char}b`, `"x${char}"`, `ok\n${char}`])
      await expect(parseCsv(utf8(input))).rejects.toMatchObject({ reason: 'control' })
  })

  it('普通的控制字符与制表符、换行照常保留（只拒绝文档流用作结构标记的那些）', async () => {
    await expect(parseCsv(utf8('a\tb,"x\ny",\u0001\u0007\u007F'))).resolves.toMatchObject({ rows: [['a\tb', 'x\ny', '\u0001\u0007\u007F']] })
  })

  it.each([[0xFF], [0xC3], [0xC0, 0xAF], [0xED, 0xA0, 0x80], [0xFF, 0xFE, 0x61, 0]])('坏 UTF-8 %j 不用替换字符悄悄接受', async (...bytes) => {
    await expect(parseCsv(new Uint8Array(bytes))).rejects.toMatchObject({ reason: 'encoding' })
  })

  it('数字、日期、危险公式形态都是原始字段，解析不执行也不推断', async () => {
    expect((await parseCsv(utf8('001,-2,2026-11-01,=1+1,+1,@x,－1'))).rows).toEqual([['001', '-2', '2026-11-01', '=1+1', '+1', '@x', '－1']])
  })

  it('字段按 UTF-16 长度计量，临界值通过、多一拒绝', async () => {
    expect((await parseCsv(utf8('一'.repeat(32_767)))).rows[0]?.[0]).toHaveLength(32_767)
    await expect(parseCsv(utf8('一'.repeat(32_768)))).rejects.toMatchObject({ reason: 'field' })
    await expect(parseCsv(utf8('😀'.repeat(16_384)))).rejects.toMatchObject({ reason: 'field' })
  })

  it('50,000 行通过，多一行拒绝', async () => {
    expect((await parseCsv(utf8('a\n'.repeat(50_000)))).rowCount).toBe(50_000)
    await expect(parseCsv(utf8('a\n'.repeat(50_001)))).rejects.toMatchObject({ reason: 'rows' })
  })

  it('1,024 列通过，多一列拒绝，即使都是空字段', async () => {
    expect((await parseCsv(utf8(','.repeat(1_023)))).columnCount).toBe(1_024)
    await expect(parseCsv(utf8(','.repeat(1_024)))).rejects.toMatchObject({ reason: 'columns' })
  })

  it('按补齐后的矩形数格：100,000 通过，多一行或后到宽行拒绝', async () => {
    const row = `${Array.from({ length: 100 }).fill('x').join(',')}\n`
    expect((await parseCsv(utf8(row.repeat(1_000)))).rowCount).toBe(1_000)
    await expect(parseCsv(utf8(row.repeat(1_001)))).rejects.toMatchObject({ reason: 'cells' })
    await expect(parseCsv(utf8(`${'x\n'.repeat(1_000)}${','.repeat(100)}`))).rejects.toMatchObject({ reason: 'cells' })
  })

  it('5 MiB 原始字节通过，多一字节在解码/字段处理之前拒绝', async () => {
    const boundary = `${'x'.repeat(32_767)}\n`.repeat(160)
    expect((await parseCsv(utf8(boundary))).rowCount).toBe(160)
    await expect(parseCsv(utf8(`${boundary}x`))).rejects.toMatchObject({ reason: 'bytes' })
  })

  it('开始前取消，不开始解析', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(parseCsv(utf8('a,b'), { signal: controller.signal })).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('解析让出后可取消，不返回半份矩阵', async () => {
    const controller = new AbortController()
    const parsing = parseCsv(utf8('a,b\n'.repeat(20_000)), { signal: controller.signal })
    setTimeout(() => controller.abort(), 0)
    await expect(parsing).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('错误不包含输入的正文', async () => {
    const result = await parseCsv(utf8('"唯一私人内容')).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(CsvError)
    expect(String(result)).not.toContain('唯一私人内容')
  })
})
