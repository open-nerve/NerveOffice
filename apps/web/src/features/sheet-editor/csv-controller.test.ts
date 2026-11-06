import { afterEach, describe, expect, it, vi } from 'vitest'
import { CsvOperationError } from '../../editor/index.ts'
import { CSV_LIMITS } from '../../shared/csv/index.ts'
import { csvFile, csvFixture, pending } from './csv-controller.test-support.ts'

vi.hoisted(() => {
  // 公开出口会装载 SDK 模块；本组只运行控制器与真实编解码，不运行 Canvas。
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})
afterEach(() => vi.useRealTimers())

describe('CSV 同页预解析交接', () => {
  const table = { rows: [['001', '=1+1']], rowCount: 1, columnCount: 2 }

  it('复用输入准备与一次插表，交接成功明确返回 true', async () => {
    const h = csvFixture()
    expect(await h.controller.importPrepared(table, h.target)).toBe(true)
    expect(h.inserted).toEqual([table])
    expect(h.events).toEqual(['prepare', 'commit', 'panels', 'formulas', 'insert'])
    expect(h.controller.view()).toMatchObject({ dialog: { kind: 'closed' }, notice: 'imported' })
  })

  it('交接的来源失效或只读时不调用输入准备', async () => {
    const h = csvFixture()
    h.state.current = false
    expect(await h.controller.importPrepared(table, h.target)).toBe(false)
    h.state.current = true
    h.state.writable = false
    expect(await h.controller.importPrepared(table, h.target)).toBe(false)
    expect(h.events).toEqual([])
  })

  it('异步准备后来源失效，不插入；失败清掉交接矩阵，普通入口仍可使用', async () => {
    const h = csvFixture()
    let current = true
    h.steps.panels = async () => {
      current = false
    }
    expect(await h.controller.importPrepared(table, { ...h.target, current: () => current })).toBe(false)
    expect(h.inserted).toEqual([])
    h.controller.openImport()
    expect(h.controller.view().dialog).toMatchObject({ kind: 'import', stage: 'selecting' })
  })

  it('已有普通 CSV 对话框时不能覆盖它的文件意图', async () => {
    const h = csvFixture()
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('原选择'))
    expect(await h.controller.importPrepared(table, h.target)).toBe(false)
    await h.controller.confirmImport()
    expect(h.inserted[0]?.rows).toEqual([['原选择']])
  })
})

describe('CSV 文件选择与预览', () => {
  it('超过 5 MiB 在读文件之前拒绝，不触碰原输入', async () => {
    const h = csvFixture()
    let reads = 0
    h.state.input = 'pending'
    h.controller.openImport()
    await h.controller.chooseFile({ name: '大文件.csv', size: CSV_LIMITS.bytes + 1, arrayBuffer: async () => {
      reads++
      return new ArrayBuffer(0)
    } })
    expect(h.controller.view()).toMatchObject({ problem: 'bytes', dialog: { kind: 'import', stage: 'selecting' } })
    expect(reads).toBe(0)
    expect(h.events).toEqual([])
    expect(h.state.input).toBe('pending')
  })

  it('真实 CSV 解析后只给出有界预览，确认前不提交输入', async () => {
    const h = csvFixture()
    h.state.input = 'pending'
    h.controller.openImport()
    const rows = Array.from({ length: 10 }, (_, row) => Array.from({ length: 10 }, (_, column) => row === 9 ? '不应进入预览的尾部' : `${row}:${column}${'字'.repeat(90)}`).join(','))
    await h.controller.chooseFile(csvFile(rows.join('\n')))
    const view = h.controller.view()
    expect(view.dialog).toMatchObject({ kind: 'import', stage: 'preview', fileName: '示例.csv', preview: { rowCount: 10, columnCount: 10 } })
    if (view.dialog.kind !== 'import' || !view.dialog.preview)
      throw new Error('没有预览')
    expect(view.dialog.preview.rows).toHaveLength(8)
    expect(view.dialog.preview.rows.every(row => row.length === 8 && row.every(cell => cell.length <= 80))).toBe(true)
    expect(JSON.stringify(view)).not.toContain('不应进入预览的尾部')
    expect(h.events).toEqual([])
    await h.controller.confirmImport()
    expect(h.inserted[0]?.rows[9]?.[9]).toBe('不应进入预览的尾部')
    expect(h.state.body).toBe('用户刚输入的文字')
    expect(h.events).toEqual(['prepare', 'commit', 'panels', 'formulas', 'insert'])
    expect(h.controller.view()).toMatchObject({ dialog: { kind: 'closed' }, notice: 'imported' })
  })

  it.each([
    ['语法', 'a"b', 'syntax'],
    ['空文件', '', 'empty'],
    ['字段过长', 'a'.repeat(32_768), 'field'],
    ['矩形超限', Array.from({ length: 101 }, () => Array.from({ length: 1_000 }).fill('').join(',')).join('\n'), 'cells'],
  ])('%s 错误不带原文、不写入，换文件仍可重试', async (_, content, problem) => {
    const h = csvFixture()
    h.controller.openImport()
    await h.controller.chooseFile(csvFile(content))
    expect(h.controller.view().problem).toBe(problem)
    expect(h.events).toEqual([])
    await h.controller.chooseFile(csvFile('甲,"乙,丙"'))
    expect(h.controller.view()).toMatchObject({ problem: undefined, dialog: { stage: 'preview', preview: { rows: [['甲', '乙,丙']] } } })
  })

  it('UTF-8 失败与读取异常分别归类，不回显异常正文', async () => {
    const h = csvFixture()
    h.controller.openImport()
    await h.controller.chooseFile({ name: '乱码.csv', size: 1, arrayBuffer: async () => new Uint8Array([0xFF]).buffer })
    expect(h.controller.view().problem).toBe('encoding')
    await h.controller.chooseFile({ name: '打不开.csv', size: 1, arrayBuffer: async () => {
      throw new Error('私密原文')
    } })
    expect(h.controller.view().problem).toBe('file-read')
    expect(JSON.stringify(h.controller.view())).not.toContain('私密原文')
  })

  it('取消迟到的文件读取，不影响后一轮选择', async () => {
    const h = csvFixture()
    const old = pending<ArrayBuffer>()
    h.controller.openImport()
    const choosing = h.controller.chooseFile({ name: '旧.csv', size: 1, arrayBuffer: async () => old.promise })
    h.controller.cancel()
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('新'))
    old.resolve(new TextEncoder().encode('旧').buffer)
    await choosing
    expect(h.controller.view().dialog).toMatchObject({ stage: 'preview', preview: { rows: [['新']] } })
    expect(h.events).toEqual([])
  })

  it('解析让出时取消，释放本轮预览且无写入', async () => {
    vi.useFakeTimers()
    const h = csvFixture()
    h.controller.openImport()
    const choosing = h.controller.chooseFile(csvFile('字'.repeat(20_000)))
    await Promise.resolve()
    h.controller.cancel()
    await vi.runAllTimersAsync()
    await choosing
    expect(h.controller.view().dialog.kind).toBe('closed')
    expect(h.controller.view().problem).toBeUndefined()
    expect(h.events).toEqual([])
  })

  it('稳定 view 与订阅仅发布本轮状态，注销后不再通知', async () => {
    const h = csvFixture()
    const first = h.controller.view()
    expect(h.controller.view()).toBe(first)
    let notifications = 0
    const off = h.controller.subscribe(() => {
      notifications++
    })
    h.controller.openImport()
    expect(notifications).toBeGreaterThan(0)
    expect(h.controller.view()).not.toBe(first)
    off()
    const before = notifications
    await h.controller.chooseFile(csvFile('1'))
    expect(notifications).toBe(before)
  })
})

describe('CSV 导入确认与失效', () => {
  it.each(['缺少编辑器', '只读或离线'] as const)('%s 无法开始导入', async (kind) => {
    const h = csvFixture()
    if (kind === '缺少编辑器')
      h.state.present = false
    else h.state.writable = false
    h.controller.environmentChanged()
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('1'))
    await h.controller.confirmImport()
    expect(h.controller.view().canImport).toBe(false)
    expect(h.controller.view().dialog.kind).toBe('closed')
    expect(h.events).toEqual([])
  })

  it('预览取消不提交原输入；重复确认只插入一张表', async () => {
    const h = csvFixture()
    h.state.input = 'pending'
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('1'))
    h.controller.cancel()
    expect(h.state.input).toBe('pending')
    expect(h.events).toEqual([])
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('2'))
    await Promise.all([h.controller.confirmImport(), h.controller.confirmImport()])
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted[0]?.rows).toEqual([['2']])
  })

  it.each(['prepare', 'commit', 'panels', 'formulas'] as const)('等待 %s 时原目标失效，不继续旧导入', async (step) => {
    const h = csvFixture()
    const gate = pending<void>()
    const arrived = pending<void>()
    if (step === 'prepare' || step === 'panels') {
      h.steps[step] = async () => {
        arrived.resolve()
        await gate.promise
      }
    }
    else if (step === 'commit') {
      h.steps.commit = async () => {
        arrived.resolve()
        await gate.promise
        return true
      }
    }
    else {
      h.steps.formulas = async () => {
        arrived.resolve()
        await gate.promise
        return 'settled'
      }
    }
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('1'))
    const confirming = h.controller.confirmImport()
    await arrived.promise
    h.state.current = false
    h.controller.environmentChanged()
    gate.resolve()
    await confirming
    expect(h.inserted).toEqual([])
    expect(h.controller.view()).toMatchObject({ problem: 'unavailable', dialog: { kind: 'closed' } })
  })

  it('普通会话确认期间暂不可写，不丢失预览；确认后恢复再插入', async () => {
    const h = csvFixture()
    h.steps.prepare = async () => {
      h.state.writable = false
      h.controller.environmentChanged()
      expect(h.controller.view().dialog.kind).toBe('import')
      h.state.writable = true
    }
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('1'))
    await h.controller.confirmImport()
    expect(h.inserted).toHaveLength(1)
  })

  it('确认后仍不可写，不提交原输入或插入', async () => {
    const h = csvFixture()
    h.steps.prepare = async () => {
      h.state.writable = false
    }
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('1'))
    await h.controller.confirmImport()
    expect(h.events).toEqual(['prepare'])
    expect(h.inserted).toEqual([])
    expect(h.controller.view().problem).toBe('read-only')
  })

  it('确认失败只显示固定分类，重试不会重复前轮写入', async () => {
    const h = csvFixture()
    h.steps.prepare = async () => {
      throw new Error('cookie=private')
    }
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('1'))
    await h.controller.confirmImport()
    expect(h.controller.view().problem).toBe('preparation-failed')
    expect(h.inserted).toEqual([])
    expect(h.state.body).toBe('原正文')
    h.steps.prepare = async () => {}
    await h.controller.confirmImport()
    expect(h.inserted).toHaveLength(1)
  })

  it('SDK 容量拒绝保留已确认提交的原文字，不留下 CSV 表', async () => {
    const h = csvFixture()
    h.state.input = 'pending'
    h.steps.insert = () => {
      throw new CsvOperationError('capacity')
    }
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('1'))
    await h.controller.confirmImport()
    expect(h.state.body).toBe('用户刚输入的文字')
    expect(h.inserted).toEqual([])
    expect(h.controller.view()).toMatchObject({ problem: 'capacity', dialog: { stage: 'preview' } })
  })

  it('销毁和取消使迟到的确认失效，之后不能重新开始', async () => {
    const h = csvFixture()
    const gate = pending<void>()
    h.steps.prepare = async () => gate.promise
    h.controller.openImport()
    await h.controller.chooseFile(csvFile('1'))
    const confirming = h.controller.confirmImport()
    h.controller.dispose()
    gate.resolve()
    await confirming
    h.controller.openImport()
    expect(h.controller.view()).toMatchObject({ canImport: false, canExport: false, dialog: { kind: 'closed' } })
    expect(h.inserted).toEqual([])
  })

  it.each(['import-input', 'import-formula', 'export-input', 'export-formula'] as const)('%s：准备结束到执行之间发生新输入/计算，最终同步栅栏仍拒绝', async (kind) => {
    const h = csvFixture()
    // 在准备层最后一次同步读之后、它的 Promise 兑现之前改变输入；不依赖等待函数有几层 async 包装。
    vi.spyOn(h.editor, 'formulasSettled').mockImplementationOnce(() => {
      queueMicrotask(() => {
        if (kind.endsWith('input'))
          h.state.input = 'pending'
        else
          h.state.settled = false
      })
      return true
    })
    if (kind.startsWith('import')) {
      h.controller.openImport()
      await h.controller.chooseFile(csvFile('1'))
      await h.controller.confirmImport()
    }
    else {
      h.controller.openExport()
      await h.controller.exportSelected()
    }
    expect(h.inserted).toEqual([])
    expect(h.downloads).toEqual([])
    expect(h.controller.view().problem).toBe(kind.endsWith('input') ? 'input-pending' : 'formula-pending')
  })
})

describe('CSV 选表与下载', () => {
  it('只读或离线仍能导出当前表，真实编码保留负数并保护字符串公式', async () => {
    const h = csvFixture()
    h.state.writable = false
    h.controller.environmentChanged()
    h.controller.openExport()
    expect(h.controller.view()).toMatchObject({ canImport: false, canExport: true, dialog: { kind: 'export', selected: 'second' } })
    await h.controller.exportSelected()
    expect(h.downloads).toHaveLength(1)
    expect([...h.downloads[0]!.bytes.slice(0, 3)]).toEqual([239, 187, 191])
    expect(new TextDecoder().decode(h.downloads[0]!.bytes)).toBe('"\t=1+2","-12.50"\r\n')
    expect(h.downloads[0]!.name).toBe('预算-第二页.csv')
    expect(h.events).toEqual(['commit', 'panels', 'formulas', 'read:second'])
    expect(h.state.body).toBe('原正文')
    expect(h.inserted).toEqual([])
    expect(h.controller.view()).toMatchObject({ dialog: { kind: 'closed' }, notice: 'exported' })
  })

  it.each([
    { name: '空字符', cells: [[{ text: 'a\0b', kind: 'text' as const }]], problem: 'export-character' },
    { name: '孤立代理字符', cells: [[{ text: '\uD800', kind: 'text' as const }]], problem: 'export-character' },
  ])('导出遇到$name：给出导出方向的提示，不沿用导入的文案，不回显正文（M5R-M-13）', async ({ cells, problem }) => {
    const h = csvFixture()
    h.steps.read = () => cells
    h.controller.openExport()
    await h.controller.exportSelected()
    expect(h.downloads).toEqual([])
    expect(h.controller.view()).toMatchObject({ problem, dialog: { kind: 'export', stage: 'choosing' } })
  })

  it('导出读取超出范围时给出导出方向的容量提示（M5R-M-13）', async () => {
    const h = csvFixture()
    h.steps.read = () => {
      throw new CsvOperationError('capacity')
    }
    h.controller.openExport()
    await h.controller.exportSelected()
    expect(h.downloads).toEqual([])
    expect(h.controller.view().problem).toBe('export-capacity')
  })

  it('用户选择仅影响导出表，不切换 SDK 活动表；未知表不能下载', async () => {
    const h = csvFixture()
    h.controller.openExport()
    h.controller.selectSheet('first')
    await h.controller.exportSelected()
    expect(new TextDecoder().decode(h.downloads[0]!.bytes)).toBe('"甲"\r\n')
    expect(h.events.at(-1)).toBe('read:first')
    h.controller.openExport()
    h.controller.selectSheet('hidden-or-missing')
    await h.controller.exportSelected()
    expect(h.controller.view().problem).toBe('sheet-missing')
    expect(h.downloads).toHaveLength(1)
  })

  it.each(['saved-pending', 'timeout', 'not-settled', 'composing', 'new-input', 'commit-refused'] as const)('%s 不下载尚未稳定的显示值', async (kind) => {
    const h = csvFixture()
    if (kind === 'saved-pending')
      h.state.formulasPending = true
    if (kind === 'timeout')
      h.steps.formulas = async () => 'timeout'
    if (kind === 'not-settled')
      h.state.settled = false
    if (kind === 'composing')
      h.state.composing = true
    if (kind === 'new-input') {
      h.steps.formulas = async () => {
        h.state.input = 'pending'
        return 'settled'
      }
    }
    if (kind === 'commit-refused')
      h.steps.commit = async () => false
    h.controller.openExport()
    await h.controller.exportSelected()
    expect(h.downloads).toEqual([])
    expect(h.events.some(event => event.startsWith('read:'))).toBe(false)
    expect(h.controller.view().problem).toBe(['composing', 'new-input', 'commit-refused'].includes(kind) ? 'input-pending' : 'formula-pending')
  })

  it('等待计算时取消，不下载，也不影响随后新一轮', async () => {
    const h = csvFixture()
    const gate = pending<'settled' | 'timeout'>()
    const arrived = pending<void>()
    h.steps.formulas = async () => {
      arrived.resolve()
      return gate.promise
    }
    h.controller.openExport()
    const exporting = h.controller.exportSelected()
    await arrived.promise
    h.controller.cancel()
    gate.resolve('settled')
    await exporting
    expect(h.downloads).toEqual([])
    expect(h.controller.view().dialog.kind).toBe('closed')
  })

  it('读取显示值后身份失效也不能下载；下载异常不吞成成功', async () => {
    const h = csvFixture()
    const original = h.steps.read
    h.steps.read = (id) => {
      h.state.current = false
      return original(id)
    }
    h.controller.openExport()
    await h.controller.exportSelected()
    expect(h.downloads).toEqual([])
    expect(h.controller.view().problem).toBe('unavailable')
    h.state.current = true
    h.steps.read = original
    h.steps.download = () => {
      throw new Error('本地下载出错')
    }
    h.controller.openExport()
    await h.controller.exportSelected()
    expect(h.controller.view()).toMatchObject({ notice: undefined, problem: 'download-failed', dialog: { stage: 'choosing' } })
  })
})
