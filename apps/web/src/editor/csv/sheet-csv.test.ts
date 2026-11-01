import type { ICellData, IWorkbookData } from '@univerjs/core'
import type { ISetArrayFormulaDataMutationParams } from '@univerjs/engine-formula'
import type { CsvTable } from '../../shared/csv/index.ts'
import { SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { BooleanNumber, CellValueType } from '@univerjs/core'
import { SetArrayFormulaDataMutation } from '@univerjs/engine-formula'
import { InsertSheetCommand, InsertSheetMutation } from '@univerjs/sheets'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CsvError } from '../../shared/csv/index.ts'
import { CsvOperationError } from './csv-operation-error.ts'
import { csvBook, csvFixture } from './csv.test-support.ts'
import { createSheetCsv } from './sheet-csv.ts'

vi.hoisted(() => {
  // 只注册数据插件；档案静态引用的 UI 在模块求值时需要这个 jsdom 缺失的构造器。
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

function setup(snapshot = csvBook(), access: 'read' | 'edit' = 'edit') {
  const fixture = csvFixture(snapshot, access)
  cleanups.push(fixture.dispose)
  const permissions = { readable: true, writable: access === 'edit', settled: true }
  const report = vi.fn()
  let identity = 0
  const newId = vi.fn(() => `csv-${++identity}`)
  const csv = createSheetCsv({
    univer: fixture.univer,
    workbook: fixture.workbook,
    univerAPI: fixture.api,
    canRead: () => permissions.readable,
    canWrite: () => permissions.writable,
    formulasSettled: () => permissions.settled,
    newId,
    reportError: report,
  })
  return { ...fixture, csv, permissions, report, newId }
}

function table(rows: string[][]): CsvTable {
  return { rows, rowCount: rows.length, columnCount: rows[0]?.length ?? 0 }
}

function first(snapshot: IWorkbookData) {
  const sheet = snapshot.sheets['sheet-1']
  if (!sheet)
    throw new Error('missing fixture sheet')
  return sheet
}

describe('CSV 单次插表，真实 SDK 命令与历史', () => {
  it('完整插入一次、原表及六类资源不变、可观察修改，一次撤销/重做恢复整张表', () => {
    const h = setup()
    const before = h.workbook.save()
    const onChange = vi.fn()
    h.changes.onChange(onChange)
    const id = h.csv.insert(table([['编号', '数量', '输入'], ['001', '-2', '=1+1']]))
    const after = h.workbook.save()
    expect(after.sheetOrder).toEqual(['sheet-1', id])
    expect(after.sheets['sheet-1']).toEqual(before.sheets['sheet-1'])
    expect(after.resources).toEqual(before.resources)
    expect(after.sheets[id]?.cellData).toEqual({
      0: { 0: { v: '编号', t: CellValueType.STRING }, 1: { v: '数量', t: CellValueType.STRING }, 2: { v: '输入', t: CellValueType.STRING } },
      1: { 0: { v: '001', t: CellValueType.STRING }, 1: { v: -2, t: CellValueType.NUMBER }, 2: { v: '=1+1', t: CellValueType.STRING } },
    })
    expect(h.workbook.getActiveSheet()?.getSheetId()).toBe(id)
    expect(onChange).toHaveBeenCalledTimes(1)
    h.workbook.undo()
    expect(h.workbook.save().sheets).toEqual(before.sheets)
    expect(h.workbook.save().sheetOrder).toEqual(before.sheetOrder)
    expect(h.workbook.save().resources).toEqual(before.resources)
    expect(h.state().history.undos).toBe(0)
    h.workbook.redo()
    expect(h.workbook.save().sheets).toEqual(after.sheets)
    expect(h.workbook.save().resources).toEqual(after.resources)
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('重复导入使用不同身份和名称，已有表名不被改写', () => {
    const snapshot = csvBook()
    first(snapshot).name = 'CSV导入'
    const h = setup(snapshot)
    h.newId.mockReturnValueOnce('sheet-1')
    const a = h.csv.insert(table([['a']]))
    const b = h.csv.insert(table([['b']]))
    expect(a).not.toBe(b)
    expect(a).not.toBe('sheet-1')
    expect(h.workbook.getSheets().map(sheet => sheet.getSheetName())).toEqual(['CSV导入', 'CSV导入 2', 'CSV导入 3'])
  })

  it.each(['read-only', 'unavailable', 'capacity', 'insert-failed'] as const)('%s：拒绝不改变原内容及既有撤销/重做状态', (reason) => {
    const snapshot = csvBook()
    if (reason === 'capacity')
      first(snapshot).cellData = { 0: { 0: { v: 'x'.repeat(SNAPSHOT_MAX_RAW_BYTES - 65_536), t: CellValueType.STRING } } }
    const h = setup(snapshot)
    h.workbook.getActiveSheet()?.getRange('B2').setValue('旧修改')
    h.workbook.undo()
    if (reason === 'read-only')
      h.permissions.writable = false
    if (reason === 'unavailable')
      h.permissions.readable = false
    const guard = h.api.addEvent(h.api.Event.BeforeCommandExecute, (event) => {
      if (reason === 'insert-failed' && event.id === InsertSheetMutation.id)
        event.cancel = true
    })
    const before = h.state()
    expect(() => h.csv.insert(table(reason === 'capacity' ? Array.from({ length: 100 }, () => ['x'.repeat(1000)]) : [['new']]))).toThrow(new CsvOperationError(reason))
    expect(h.state()).toEqual(before)
    guard.dispose()
  })

  it('命令入口被拒绝也不留下空表', () => {
    const h = setup()
    const guard = h.api.addEvent(h.api.Event.BeforeCommandExecute, (event) => {
      if (event.id === InsertSheetCommand.id)
        event.cancel = true
    })
    const before = h.state()
    expect(() => h.csv.insert(table([['new']]))).toThrow(new CsvOperationError('insert-failed'))
    expect(h.state()).toEqual(before)
    guard.dispose()
  })

  it('无法生成无冲突身份时有界拒绝，无写入', () => {
    const h = setup()
    h.newId.mockReturnValue('sheet-1')
    const before = h.state()
    expect(() => h.csv.insert(table([['new']]))).toThrow(new CsvOperationError('insert-failed'))
    expect(h.newId.mock.calls.length).toBeLessThanOrEqual(16)
    expect(h.state()).toEqual(before)
  })

  it('完整插表后的实际快照恰好 5 MiB 可接受，多一字节时在命令前拒绝', () => {
    const snapshot = csvBook()
    first(snapshot).cellData = { 0: { 0: { v: '', t: CellValueType.STRING } } }
    const probe = setup(snapshot)
    probe.csv.insert(table([['new']]))
    const overhead = new TextEncoder().encode(JSON.stringify(probe.workbook.save())).byteLength
    expect(snapshot.sheetOrder).toEqual(['sheet-1'])
    for (const extra of [0, 1]) {
      const candidate = structuredClone(snapshot)
      first(candidate).cellData = { 0: { 0: { v: 'x'.repeat(SNAPSHOT_MAX_RAW_BYTES - overhead + extra), t: CellValueType.STRING } } }
      const h = setup(candidate)
      const before = h.state()
      if (extra === 0) {
        h.csv.insert(table([['new']]))
        expect(new TextEncoder().encode(JSON.stringify(h.workbook.save())).byteLength).toBe(SNAPSHOT_MAX_RAW_BYTES)
      }
      else {
        expect(() => h.csv.insert(table([['new']]))).toThrow(new CsvOperationError('capacity'))
        expect(h.state()).toEqual(before)
      }
    }
  })

  it('插入后的视图激活异常仍返回已导入的表，并报告原异常', () => {
    const h = setup()
    const error = new Error('activate failed')
    vi.spyOn(h.workbook, 'setActiveSheet').mockImplementation(() => {
      throw error
    })
    const id = h.csv.insert(table([['new']]))
    expect(h.workbook.save().sheets[id]?.cellData?.[0]?.[0]?.v).toBe('new')
    expect(h.report).toHaveBeenCalledExactlyOnceWith(error)
    h.workbook.undo()
    expect(h.workbook.save().sheetOrder).toEqual(['sheet-1'])
  })
})

describe('CSV 显示值读取', () => {
  it('只列出可见表并标记当前表；按指定表读取，隐藏及未知表拒绝', () => {
    const snapshot = csvBook()
    snapshot.sheets.other = { ...structuredClone(first(snapshot)), id: 'other', name: '另一表', cellData: { 0: { 0: { v: 'other', t: CellValueType.STRING } } } }
    snapshot.sheets.hidden = { ...structuredClone(first(snapshot)), id: 'hidden', name: '隐藏表', hidden: BooleanNumber.TRUE }
    snapshot.sheetOrder.push('other', 'hidden')
    const h = setup(snapshot)
    expect(h.csv.sheets()).toEqual([{ id: 'sheet-1', name: '工作表1', active: true }, { id: 'other', name: '另一表', active: false }])
    expect(h.csv.read('other')).toEqual([[{ text: 'other', kind: 'text' }]])
    expect(() => h.csv.read('hidden')).toThrow(new CsvOperationError('sheet-missing'))
    expect(() => h.csv.read('missing')).toThrow(new CsvOperationError('sheet-missing'))
  })

  it('真实格式化后的数字、日期、布尔、富文本与公式缓存；输出不含公式或图片资源', () => {
    const snapshot = csvBook()
    snapshot.styles = { n: { n: { pattern: '#,##0.00' } }, d: { n: { pattern: 'yyyy-mm-dd' } } }
    first(snapshot).cellData = { 0: {
      0: { v: -1234.5, t: CellValueType.NUMBER, s: 'n' },
      1: { v: 45292, t: CellValueType.NUMBER, s: 'd' },
      2: { v: 1, t: CellValueType.BOOLEAN },
      3: { p: { id: 'rich', body: { dataStream: '文字\r\n' }, documentStyle: {} } },
      4: { v: 4, t: CellValueType.NUMBER, f: '=2+2' },
      5: { v: '=user text', t: CellValueType.STRING },
    } }
    const h = setup(snapshot)
    expect(h.csv.read('sheet-1')).toEqual([[
      { text: '-1,234.50', kind: 'number' },
      { text: '2024-01-01', kind: 'number' },
      { text: 'TRUE', kind: 'text' },
      { text: '文字', kind: 'text' },
      { text: '4', kind: 'number' },
      { text: '=user text', kind: 'text' },
    ]])
    expect(JSON.stringify(h.csv.read('sheet-1'))).not.toContain('/api/assets/')
  })

  it('空表（含浮动图片）为一个空格；远处纯格式不扩大 CSV', () => {
    const snapshot = csvBook()
    first(snapshot).rowCount = 100_000
    first(snapshot).columnCount = 2000
    first(snapshot).cellData = { 90_000: { 1500: { s: { bg: { rgb: '#ff0000' } } } } }
    const h = setup(snapshot)
    expect(h.csv.read('sheet-1')).toEqual([[{ text: '', kind: 'text' }]])
  })

  it('保留 A1 到末个内容的矩形、中间空格及非 A1 起点；0 与 false 都是内容', () => {
    const snapshot = csvBook()
    first(snapshot).cellData = { 1: { 1: { v: 0, t: CellValueType.NUMBER } }, 2: { 2: { v: false, t: CellValueType.BOOLEAN } } }
    const h = setup(snapshot)
    const empty = { text: '', kind: 'text' }
    expect(h.csv.read('sheet-1')).toEqual([
      [empty, empty, empty],
      [empty, { text: '0', kind: 'number' }, empty],
      [empty, empty, { text: 'FALSE', kind: 'text' }],
    ])
  })

  it('空缓存的公式仍保留其位置，空值及空富文本不扩大范围', () => {
    const snapshot = csvBook()
    first(snapshot).cellData = { 1: { 1: { v: '', f: '=IF(TRUE,"",1)' } }, 900: { 10: { v: '' }, 11: { p: { id: 'blank', body: { dataStream: '\r\n' }, documentStyle: {} } } } }
    const h = setup(snapshot)
    expect(h.csv.read('sheet-1')).toEqual(Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => ({ text: '', kind: 'text' }))))
  })

  it('空富文本正文下 SDK 仍显示的原值不能被范围扫描漏掉', () => {
    const snapshot = csvBook()
    first(snapshot).cellData = { 1: {
      0: { v: '保留', p: { id: 'empty-rich', body: { dataStream: '' }, documentStyle: {} } },
      1: { v: -2, t: CellValueType.NUMBER, p: { id: 'empty-numeric', body: { dataStream: '' }, documentStyle: {} } },
    } }
    const h = setup(snapshot)
    expect(h.csv.read('sheet-1')).toEqual([
      [{ text: '', kind: 'text' }, { text: '', kind: 'text' }],
      [{ text: '保留', kind: 'text' }, { text: '-2', kind: 'number' }],
    ])
  })

  it.each([
    [50_000, 0, 'rows'],
    [0, 1024, 'columns'],
    [100, 1000, 'cells'],
  ] as const)('内容在 %i/%i 超出 %s 时在分配矩形之前拒绝', (row, column, reason) => {
    const snapshot = csvBook()
    first(snapshot).rowCount = 100_000
    first(snapshot).columnCount = 2000
    first(snapshot).cellData = { [row]: { [column]: { v: 'far', t: CellValueType.STRING } } }
    const h = setup(snapshot)
    expect(() => h.csv.read('sheet-1')).toThrow(new CsvError(reason))
  })

  it('只读模式读前读后快照字节相同，不能导入', () => {
    const snapshot = csvBook()
    first(snapshot).cellData = { 0: { 0: { v: 7, t: CellValueType.NUMBER, s: { n: { pattern: '0.00' } } } } }
    const h = setup(snapshot, 'read')
    const before = h.state()
    expect(h.csv.sheets()).toHaveLength(1)
    expect(h.csv.read('sheet-1')).toEqual([[{ text: '7.00', kind: 'number' }]])
    expect(() => h.csv.insert(table([['no']]))).toThrow(new CsvOperationError('read-only'))
    expect(h.state()).toEqual(before)
  })

  it('公式未完成时拒绝读取，不把旧缓存冒作当前结果', () => {
    const h = setup()
    h.permissions.settled = false
    expect(() => h.csv.read('sheet-1')).toThrow(new CsvOperationError('formula-pending'))
  })

  it('失效的旧能力对象拒绝列举和读取', () => {
    const h = setup()
    h.permissions.readable = false
    expect(() => h.csv.sheets()).toThrow(new CsvOperationError('unavailable'))
    expect(() => h.csv.read('sheet-1')).toThrow(new CsvOperationError('unavailable'))
  })
})

describe('CSV 数组公式显示结果（真实缓存 mutation 与 CELL_CONTENT 通道）', () => {
  function publish(h: ReturnType<typeof setup>, cells: Record<number, Record<number, ICellData | null>>, endRow = 1, endColumn = 1) {
    const params: ISetArrayFormulaDataMutationParams = {
      arrayFormulaRange: { 'csv-book': { 'sheet-1': { 0: { 0: { startRow: 0, startColumn: 0, endRow, endColumn } } } } },
      arrayFormulaCellData: { 'csv-book': { 'sheet-1': cells } },
      arrayFormulaEmbedded: {},
    }
    expect(h.api.syncExecuteCommand(SetArrayFormulaDataMutation.id, params, { onlyLocal: true })).toBe(true)
  }

  it('原存储只有锚点时仍完整导出 2×2 溢出结果；只读前后快照字节相同', () => {
    const snapshot = csvBook()
    const anchor = { v: -1, t: CellValueType.NUMBER, f: '=SEQUENCE(2,2,-1,-1)' }
    first(snapshot).cellData = { 0: { 0: anchor } }
    const h = setup(snapshot, 'read')
    publish(h, { 0: { 0: { v: -1, t: CellValueType.NUMBER }, 1: { v: -2, t: CellValueType.NUMBER } }, 1: { 0: { v: -3, t: CellValueType.NUMBER }, 1: { v: -4, t: CellValueType.NUMBER } } })
    const before = h.state()
    // 固定 SDK 真实显示完整结果；它没有把溢出格写进 save().cellData。
    expect(h.workbook.getActiveSheet()?.getRange('A1:B2').getDisplayValues()).toEqual([['-1', '-2'], ['-3', '-4']])
    expect(first(h.workbook.save()).cellData).toEqual({ 0: { 0: anchor } })
    expect(h.csv.read('sheet-1')).toEqual([
      [{ text: '-1', kind: 'number' }, { text: '-2', kind: 'number' }],
      [{ text: '-3', kind: 'number' }, { text: '-4', kind: 'number' }],
    ])
    expect(h.state()).toEqual(before)
  })

  it('缓存覆盖 v/t 后仍保留原富文本优先级、数字格式与 nullish→0 规则', () => {
    const snapshot = csvBook()
    first(snapshot).cellData = { 0: {
      0: { v: 1, t: CellValueType.NUMBER, f: '=SEQUENCE(1,5)' },
      1: { v: '原值', t: CellValueType.STRING, s: { n: { pattern: '#,##0.00' } } },
      2: { v: '原值', p: { id: 'rich', body: { dataStream: '富文本\r\n' }, documentStyle: {} } },
      3: { v: '原值', p: { id: 'empty', body: { dataStream: '' }, documentStyle: {} } },
    } }
    const h = setup(snapshot)
    publish(h, { 0: { 0: { v: 1, t: CellValueType.NUMBER }, 1: { v: '-1234.5', t: CellValueType.NUMBER }, 2: { v: 8, t: CellValueType.NUMBER }, 3: {}, 4: { v: 0, t: CellValueType.BOOLEAN } } }, 0, 4)
    expect(h.workbook.getActiveSheet()?.getRange('A1:E1').getDisplayValues()).toEqual([['1', '-1,234.50', '富文本', '0', 'FALSE']])
    expect(h.csv.read('sheet-1')).toEqual([[
      { text: '1', kind: 'number' },
      { text: '-1,234.50', kind: 'number' },
      { text: '富文本', kind: 'text' },
      { text: '0', kind: 'number' },
      { text: 'FALSE', kind: 'text' },
    ]])
  })

  it('实际空字符串公式结果保留格位置；仅有意图范围和已清除缓存不扩大 CSV', () => {
    const h = setup()
    publish(h, { 1: { 1: { v: '', t: CellValueType.STRING } }, 50_000: { 2000: null } }, 60_000, 2000)
    expect(h.csv.read('sheet-1')).toEqual(Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => ({ text: '', kind: 'text' }))))
  })

  it.each([
    [50_000, 0, 'rows'],
    [0, 1024, 'columns'],
    [100, 1000, 'cells'],
  ] as const)('缓存格 %i/%i 超出 %s 时在分配显示矩形前拒绝', (row, column, reason) => {
    const snapshot = csvBook()
    first(snapshot).rowCount = 100_000
    first(snapshot).columnCount = 2000
    const h = setup(snapshot)
    publish(h, { [row]: { [column]: { v: -1, t: CellValueType.NUMBER } } }, row, column)
    expect(() => h.csv.read('sheet-1')).toThrow(new CsvError(reason))
  })

  it('其他工作簿或其他表的缓存不会泄露到当前表', () => {
    const h = setup()
    const params: ISetArrayFormulaDataMutationParams = {
      arrayFormulaRange: {},
      arrayFormulaCellData: { 'other': { 'sheet-1': { 0: { 0: { v: '其他文档' } } } }, 'csv-book': { other: { 0: { 0: { v: '其他表' } } } } },
      arrayFormulaEmbedded: {},
    }
    expect(h.api.syncExecuteCommand(SetArrayFormulaDataMutation.id, params, { onlyLocal: true })).toBe(true)
    expect(h.csv.read('sheet-1')).toEqual([[{ text: '', kind: 'text' }]])
  })
})
