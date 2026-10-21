import type { IDataValidationRule, IDisposable, IWorkbookData, Workbook } from '@univerjs/core'
import type * as FormulaUI from '@univerjs/sheets-formula-ui'
import type { ComponentType, Ref } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { DataValidationOperator, DataValidationType, FOCUSING_SHEET, ICommandService, IContextService, ILogService, IUndoRedoService, IUniverInstanceService, LocaleService, RedoCommand, UndoCommand, Univer, UniverInstanceType } from '@univerjs/core'
import { AddDataValidationMutation, DataValidationModel, DataValidatorRegistryService, RemoveDataValidationMutation, UpdateDataValidationMutation } from '@univerjs/data-validation'
import { LexerTreeBuilder } from '@univerjs/engine-formula'
import { SheetsSelectionsService } from '@univerjs/sheets'
import { BASE_FORMULA_INPUT_NAME, DataValidationCacheService, RemoveSheetDataValidationCommand, SheetDataValidationModel, UpdateSheetDataValidationOptionsCommand, UpdateSheetDataValidationRangeCommand, UpdateSheetDataValidationSettingCommand } from '@univerjs/sheets-data-validation'
import { UniverSheetsDataValidationUIPlugin } from '@univerjs/sheets-data-validation-ui'
import { ComponentManager, RediContext } from '@univerjs/ui'
import { useImperativeHandle, useRef } from 'react'
import { BehaviorSubject } from 'rxjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { injectorOf } from './injector.ts'

// SDK 导入时创建下拉箭头的 Path2D；本组不绘制箭头，实际渲染由 E2E 覆盖。
vi.hoisted(() => vi.stubGlobal('Path2D', class {}))

// jsdom 无法画 RangeSelector 的画布。仅替换输入端口，详情组件、状态、队列、规则与命令仍取实际发布包。
vi.mock('@univerjs/sheets-formula-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof FormulaUI>()
  return {
    ...actual,
    RangeSelector: ({ selectorRef, initialValue, onChange }: {
      selectorRef: Ref<unknown>
      initialValue: string
      onChange: (doc: unknown, value: string) => void
    }) => {
      const valueRef = useRef(initialValue)
      useImperativeHandle(selectorRef, () => ({ verify: () => true, getValue: () => valueRef.current, editor: { isFocus: () => false } }))
      return (
        <textarea
          aria-label="范围"
          defaultValue={initialValue}
          onChange={(event) => {
            valueRef.current = event.target.value
            onChange(null, event.target.value)
          }}
        />
      )
    },
  }
})

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(dispose => dispose())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup(kind: 'number' | 'custom' | 'bound' = 'number', requireFormula = false) {
  vi.useFakeTimers()
  const univer = new Univer()
  const injector = injectorOf(univer)
  const commands = injector.get(ICommandService)
  const instances = injector.get(IUniverInstanceService)
  const createWorkbook = (id = 'wb') => univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id,
    sheetOrder: ['s1'],
    sheets: { s1: { id: 's1', name: 'Sheet1', rowCount: 10, columnCount: 10, cellData: {} } },
  })
  const workbook = createWorkbook()
  instances.focusUnit('wb')
  injector.get(IContextService).setContextValue(FOCUSING_SHEET, true)
  const data = new DataValidationModel(injector.get(ILogService))
  const validator = {
    id: 'decimal',
    type: 'decimal',
    operators: [DataValidationOperator.EQUAL],
    operatorNames: ['等于'],
    title: '数字',
    // 公式输入端口采用 SDK 的 BaseFormulaInput；custom 的实际画布另由公开 E2E 覆盖。
    formulaInput: BASE_FORMULA_INPUT_NAME,
    validatorFormula: (rule: IDataValidationRule) => ({ success: !requireFormula || Boolean(rule.formula1) }),
    normalizeFormula: () => ({}),
    validator: async () => true,
  }
  const integerValidator = { ...validator, id: 'whole', type: 'whole', title: '整数' }
  const customValidator = { ...validator, id: 'custom', type: 'custom', title: '自定义公式', operators: [], operatorNames: [], offsetFormulaByRange: true }
  const validators = [validator, integerValidator, customValidator]
  const registry = {
    getValidatorItem: (type: string) => validators.find(item => item.type === type),
    getValidatorsByScope: () => validators,
  }
  const cache = new DataValidationCacheService(commands, instances, data)
  const model = new SheetDataValidationModel(data, instances, registry as never, cache, { addRule() {}, removeRule() {} } as never, { addRule() {}, deleteByRuleId() {} } as never, commands)
  injector.add([DataValidationModel, { useValue: data }])
  injector.add([SheetDataValidationModel, { useValue: model }])
  injector.add([DataValidatorRegistryService, { useValue: registry as never }])
  injector.add([SheetsSelectionsService, { useValue: { getCurrentLastSelection: () => null } as never }])
  // 范围命令使用发布包的真实公式解析与位移，不能用手写替身证明引用保持。
  injector.add([LexerTreeBuilder])
  injector.get(IUndoRedoService)
  for (const command of [AddDataValidationMutation, RemoveDataValidationMutation, UpdateDataValidationMutation, UpdateSheetDataValidationSettingCommand, UpdateSheetDataValidationOptionsCommand, UpdateSheetDataValidationRangeCommand, RemoveSheetDataValidationCommand]) {
    if (!commands.hasCommand(command.id))
      commands.registerCommand(command)
  }
  const initial: IDataValidationRule = {
    uid: 'dv1',
    type: kind === 'custom' ? DataValidationType.CUSTOM : DataValidationType.DECIMAL,
    operator: DataValidationOperator.EQUAL,
    formula1: kind === 'custom' ? '=C3>5' : kind === 'bound' ? '=$A$1' : '100',
    allowBlank: true,
    errorStyle: 2,
    ranges: [{ startRow: 2, endRow: 2, startColumn: 2, endColumn: 2 }],
  }
  data.addRule('wb', 's1', initial, 'patched')
  const current = () => data.getRuleById('wb', 's1', 'dv1')!
  const activeRule$ = new BehaviorSubject({ unitId: 'wb', subUnitId: 's1', rule: current() })
  const panelOpen$ = new BehaviorSubject(true)
  const close = vi.fn()
  const panelService = {
    activeRule: activeRule$.value,
    activeRule$,
    open$: panelOpen$,
    setActiveRule: close,
    getFocusFormulaEditorActiveRuleSubUnitId: () => null,
  }
  // 通过实际插件登记取得真实面板组件和未公开的服务 token，不复制被测函数或添加测试专用 SDK 导出。
  const dependencies: unknown[][] = []
  const components = new ComponentManager(injector.get(ILogService))
  const registration = {
    add: (entry: unknown[]) => { dependencies.push(entry) },
    get: (token: unknown) => {
      const Controller = token as new (...args: unknown[]) => IDisposable
      if (Controller.name === 'ComponentsController') {
        const controller = new Controller(components, { register: () => ({ dispose() {} }) })
        cleanups.push(() => controller.dispose())
      }
      return {}
    },
  }
  const plugin = new UniverSheetsDataValidationUIPlugin({}, registration as never, { registerCommand() {} } as never, { setConfig() {} } as never)
  plugin.onStarting()
  const panelToken = dependencies.find(([token]) => typeof token === 'function' && token.name === 'DataValidationPanelService')![0]
  injector.add([panelToken as never, { useValue: panelService }])
  injector.add([ComponentManager, { useValue: components }])
  vi.spyOn(injector.get(LocaleService), 't').mockImplementation(key => ({
    'sheets-data-validation-ui.panel.allowBlank': '忽略空值',
    'sheets-data-validation-ui.panel.options': '高级设置',
    'sheets-data-validation-ui.panel.rejectInput': '拒绝输入',
    'sheets-data-validation-ui.panel.showWarning': '显示警告',
    'sheets-data-validation-ui.panel.done': '确认',
    'sheets-data-validation-ui.panel.formulaPlaceholder': '规则公式',
    'sheets-data-validation-ui.panel.removeRule': '删除规则',
  }[key] ?? key))
  const Panel = components.get('DataValidationPanel') as ComponentType
  expect(Panel, '发布包仍应通过 ComponentsController 登记面板').toBeDefined()
  const view = render(<RediContext value={{ injector }}><Panel /></RediContext>)
  cleanups.push(() => {
    view.unmount()
    plugin.dispose()
    model.dispose()
    cache.dispose()
    data.dispose()
    activeRule$.complete()
    panelOpen$.complete()
    univer.dispose()
  })
  const setting = () => fireEvent.click(screen.getByText('忽略空值'))
  const option = () => {
    fireEvent.click(screen.getByText('高级设置'))
    fireEvent.click(screen.getByText('拒绝输入'))
  }
  const tick = async (ms = 1001) => act(async () => vi.advanceTimersByTimeAsync(ms))
  return { current, setting, option, tick, commands, data, workbook, instances, createWorkbook, view, close, panelOpen$ }
}

describe('UR-033：实际数据验证详情组件的连续编辑', () => {
  it.each([false, true])('不同种更新都执行（反序：%s）', async (reverse) => {
    const h = setup()
    if (reverse) {
      h.option()
      h.setting()
    }
    else {
      h.setting()
      h.option()
    }
    expect(h.current()).toMatchObject({ allowBlank: true, errorStyle: 2 })
    await h.tick()
    expect(h.current()).toMatchObject({ allowBlank: false, errorStyle: 1 })
  })

  it('同种连续编辑仍合并为最后一次，边界前不提前写入', async () => {
    const h = setup()
    h.setting()
    h.setting()
    h.setting()
    await h.tick(999)
    expect(h.current().allowBlank).toBe(true)
    await h.tick(2)
    expect(h.current().allowBlank).toBe(false)
  })

  it('确认同步提交，随后卸载及计时器到点不重复执行', async () => {
    const h = setup()
    h.setting()
    fireEvent.click(screen.getByText('确认'))
    expect(h.current().allowBlank).toBe(false)
    expect(h.close).toHaveBeenCalledWith(null)
    const rule = h.current()
    h.view.unmount()
    await h.tick()
    expect(h.current()).toBe(rule)
  })

  it('直接关闭详情在原实例还活跃时提交', () => {
    const h = setup()
    h.setting()
    h.view.unmount()
    expect(h.current().allowBlank).toBe(false)
  })

  it('侧边栏已关闭但详情暂未卸载时就提交，不能等隐藏后的清理或计时器', () => {
    const h = setup()
    h.setting()
    act(() => h.panelOpen$.next(false))
    expect(h.current().allowBlank).toBe(false)
    expect(screen.getByText('忽略空值')).toBeInTheDocument()
  })

  it('工作簿退役后不会把旧输入提交到同 id 新工作簿', async () => {
    const h = setup()
    h.setting()
    act(() => {
      h.instances.disposeUnit('wb')
      h.createWorkbook()
    })
    await h.tick()
    expect(h.current().allowBlank).toBe(true)
  })

  it('范围与设置连续输入均写入实际模型', async () => {
    const h = setup()
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'C3:C4' } })
    h.setting()
    await h.tick()
    expect(h.current()).toMatchObject({ allowBlank: false, ranges: [{ startRow: 2, endRow: 3, startColumn: 2, endColumn: 2 }] })
  })

  it.each(['C\r\nC4\nC\nC', 'C0', 'ZZZ4'])('无效范围 %j 不能删除原规则，确认保持面板开启，改正后可以提交', async (value) => {
    const h = setup()
    const initial = h.current()
    fireEvent.change(screen.getByLabelText('范围'), { target: { value } })
    await h.tick()
    expect(h.current()).toEqual(initial)
    fireEvent.click(screen.getByText('确认'))
    expect(h.close).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'C3:C4' } })
    fireEvent.click(screen.getByText('确认'))
    expect(h.current().ranges).toEqual([{ startRow: 2, endRow: 3, startColumn: 2, endColumn: 2 }])
    expect(h.close).toHaveBeenCalledWith(null)
  })

  it('合法整列范围沿 SDK rangeType 处理，不能因开放的行坐标而误拒绝', async () => {
    const h = setup()
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'C:C' } })
    await h.tick()
    expect(h.current().ranges).toEqual([{ startRow: 0, endRow: 9, startColumn: 2, endColumn: 2 }])
    fireEvent.click(screen.getByText('确认'))
    expect(h.close).toHaveBeenCalledWith(null)
  })

  it('撤销与重做之前取消未提交的旧选项，之后的计时器不能覆盖历史结果', async () => {
    const h = setup()
    h.setting()
    await h.tick()
    h.option()
    await act(async () => {
      expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    })
    await h.tick()
    expect(h.current()).toMatchObject({ allowBlank: true, errorStyle: 2 })
    await act(async () => {
      expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    })
    await h.tick()
    expect(h.current()).toMatchObject({ allowBlank: false, errorStyle: 2 })
  })

  it.each([false, true])('范围撤销后确认不复活已撤销输入（立即确认：%s）', async (immediate) => {
    const h = setup()
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'C3:C4' } })
    await h.tick()
    await act(async () => {
      expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    })
    if (!immediate)
      await h.tick(21)
    expect.soft(screen.getByLabelText('范围')).toHaveValue('C3')
    fireEvent.click(screen.getByText('确认'))
    expect(h.current().ranges).toEqual([{ startRow: 2, endRow: 2, startColumn: 2, endColumn: 2 }])
    expect(h.close).toHaveBeenCalledWith(null)
  })

  it('范围重做刷新正文，确认保留重做后的范围', async () => {
    const h = setup()
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'C3:C4' } })
    await h.tick()
    await act(async () => {
      expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    })
    await h.tick(21)
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'C0' } })
    await act(async () => {
      expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    })
    expect.soft(screen.getByLabelText('范围')).toHaveValue('C3:C4')
    fireEvent.click(screen.getByText('确认'))
    expect(h.current().ranges).toEqual([{ startRow: 2, endRow: 3, startColumn: 2, endColumn: 2 }])
    expect(h.close).toHaveBeenCalledWith(null)
  })

  it.each(['custom', 'bound'] as const)('%s 规则移动范围后修改设置，不覆盖实际命令的公式结果', async (kind) => {
    const h = setup(kind)
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'D4' } })
    h.setting()
    await h.tick()
    const formula1 = kind === 'custom' ? '=D4>5' : '=$A$1'
    expect(h.current()).toMatchObject({ formula1, allowBlank: false, ranges: [{ startRow: 3, endRow: 3, startColumn: 3, endColumn: 3 }] })
    h.setting()
    await h.tick()
    expect(h.current()).toMatchObject({ formula1, allowBlank: true })
    fireEvent.click(screen.getByText('确认'))
    expect(h.current().formula1).toBe(formula1)
  })

  it('自定义公式范围先独立提交，再改设置仍保留平移结果', async () => {
    const h = setup('custom')
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'D4' } })
    await h.tick()
    expect(h.current().formula1).toBe('=D4>5')
    h.setting()
    await h.tick()
    expect(h.current()).toMatchObject({ formula1: '=D4>5', allowBlank: false })
  })

  it('设置、范围、设置不跨范围合并，显式公式修改按输入顺序平移', async () => {
    const h = setup('custom')
    fireEvent.change(screen.getByPlaceholderText('规则公式'), { target: { value: '=C3>7' } })
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'D4' } })
    h.setting()
    await h.tick()
    expect(h.current()).toMatchObject({ formula1: '=D4>7', allowBlank: false })
    expect(screen.getByPlaceholderText('规则公式')).toHaveValue('=D4>7')
    await act(async () => {
      expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    })
    expect(h.current()).toMatchObject({ formula1: '=D4>7', allowBlank: true })
    await act(async () => {
      expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    })
    expect(h.current()).toMatchObject({ formula1: '=C3>7', ranges: [{ startRow: 2, endRow: 2, startColumn: 2, endColumn: 2 }] })
    await act(async () => {
      expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    })
    expect(screen.getByPlaceholderText('规则公式')).toHaveValue('=D4>7')
    fireEvent.click(screen.getByText('确认'))
    expect(h.current().formula1).toBe('=D4>7')
  })

  it('先移动范围再显式修改公式，以用户随后输入的公式为准', async () => {
    const h = setup('custom')
    h.setting()
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'D4' } })
    fireEvent.change(screen.getByPlaceholderText('规则公式'), { target: { value: '=D4>9' } })
    await h.tick()
    expect(h.current()).toMatchObject({ formula1: '=D4>9', allowBlank: false })
    expect(screen.getByPlaceholderText('规则公式')).toHaveValue('=D4>9')
  })

  it('范围命令拒绝后设置不能越过它执行，明确重试仍按原顺序完成', async () => {
    const h = setup('custom')
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'D4' } })
    h.setting()
    vi.spyOn(h.commands, 'syncExecuteCommand').mockReturnValueOnce(false)
    await h.tick()
    expect(h.current()).toMatchObject({ formula1: '=C3>5', allowBlank: true })
    fireEvent.click(screen.getByText('确认'))
    expect(h.current()).toMatchObject({ formula1: '=D4>5', allowBlank: false })
    expect(h.close).toHaveBeenCalledWith(null)
  })

  it('删除先提交当前输入，撤销删除恢复最后编辑的规则', async () => {
    const h = setup()
    h.setting()
    await act(async () => fireEvent.click(screen.getByText('删除规则')))
    expect(h.current()).toBeUndefined()
    await act(async () => {
      expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    })
    expect(h.current()?.allowBlank).toBe(false)
    await h.tick()
    expect(h.current()?.allowBlank).toBe(false)
  })

  it('外部删除再添加同 id 规则时，旧输入不能写入新规则', async () => {
    const h = setup()
    h.setting()
    act(() => {
      h.data.removeRule('wb', 's1', 'dv1', 'patched')
      h.data.addRule('wb', 's1', { uid: 'dv1', type: DataValidationType.DECIMAL, formula1: '200', allowBlank: true, ranges: [] }, 'patched')
    })
    await h.tick()
    expect(h.current()).toMatchObject({ allowBlank: true, formula1: '200' })
  })

  it('命令拒绝时不关闭详情，下一次确认仍可提交原来的输入', () => {
    const h = setup()
    vi.spyOn(h.commands, 'syncExecuteCommand').mockReturnValueOnce(false)
    h.setting()
    fireEvent.click(screen.getByText('确认'))
    expect(h.current().allowBlank).toBe(true)
    expect(h.close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('确认'))
    expect(h.current().allowBlank).toBe(false)
    expect(h.close).toHaveBeenCalledWith(null)
  })

  it('删除前提交被拒绝时保留详情和规则，重试删除后的撤销仍恢复最新输入', async () => {
    const h = setup()
    vi.spyOn(h.commands, 'syncExecuteCommand').mockReturnValueOnce(false)
    h.setting()
    await act(async () => fireEvent.click(screen.getByText('删除规则')))
    expect(h.current()?.allowBlank).toBe(true)
    expect(h.close).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByText('删除规则')))
    expect(h.current()).toBeUndefined()
    await act(async () => {
      expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    })
    expect(h.current()?.allowBlank).toBe(false)
  })

  it('切换类型前提交被拒绝时不覆盖旧输入，重试切换会一同提交', async () => {
    const h = setup()
    vi.spyOn(h.commands, 'syncExecuteCommand').mockReturnValueOnce(false)
    h.setting()
    const chooseInteger = async () => {
      fireEvent.pointerDown(screen.getByText('数字'), { button: 0, ctrlKey: false })
      await h.tick(1)
      fireEvent.click(screen.getByRole('menuitemradio', { name: '整数' }))
    }
    await chooseInteger()
    expect(h.current()).toMatchObject({ type: 'decimal', allowBlank: true })
    await chooseInteger()
    expect(h.current()).toMatchObject({ type: 'whole', allowBlank: false })
  })

  it.each([
    { label: '整数', type: 'whole', formula1: '5' },
    { label: '自定义公式', type: 'custom', formula1: '=C3>7' },
  ])('新 $label 的空公式尚不能提交，补公式后应一同应用所选类型', async ({ label, type, formula1 }) => {
    const h = setup('number', true)
    fireEvent.pointerDown(screen.getByText('数字'), { button: 0, ctrlKey: false })
    await h.tick(1)
    fireEvent.click(screen.getByRole('menuitemradio', { name: label }))
    await h.tick(1)
    expect(h.current()).toMatchObject({ type: 'decimal', formula1: '100' })
    fireEvent.change(screen.getByPlaceholderText('规则公式'), { target: { value: formula1 } })
    await h.tick()
    expect(h.current()).toMatchObject({ type, formula1 })
    fireEvent.click(screen.getByText('确认'))
    expect(h.close).toHaveBeenCalledWith(null)
  })

  it('尚未生效的新类型、公式、范围、设置按顺序提交，不能再用类型草稿覆盖平移结果', async () => {
    const h = setup('number', true)
    fireEvent.pointerDown(screen.getByText('数字'), { button: 0, ctrlKey: false })
    await h.tick(1)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '自定义公式' }))
    await h.tick(1)
    expect(h.current().type).toBe('decimal')
    fireEvent.change(screen.getByPlaceholderText('规则公式'), { target: { value: '=C3>7' } })
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'D4' } })
    h.setting()
    await h.tick()
    expect(h.current()).toMatchObject({ type: 'custom', formula1: '=D4>7', allowBlank: false })
    expect(h.current().operator).toBeUndefined()
    expect(screen.getByPlaceholderText('规则公式')).toHaveValue('=D4>7')
  })

  it.each(['范围', '高级设置'])('新类型等待补公式时，先提交%s不能丢失所选类型', async (part) => {
    const h = setup('number', true)
    fireEvent.pointerDown(screen.getByText('数字'), { button: 0, ctrlKey: false })
    await h.tick(1)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '自定义公式' }))
    await h.tick(1)
    if (part === '范围')
      fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'D4' } })
    else
      h.option()
    await h.tick()
    expect(h.current().type).toBe('decimal')
    expect(screen.getByText('自定义公式')).toBeVisible()
    fireEvent.change(screen.getByPlaceholderText('规则公式'), { target: { value: '=D4>7' } })
    await h.tick()
    expect(h.current()).toMatchObject({ type: 'custom', formula1: '=D4>7' })
    if (part === '范围')
      expect(h.current().ranges).toEqual([{ startRow: 3, endRow: 3, startColumn: 3, endColumn: 3 }])
    else
      expect(h.current().errorStyle).toBe(1)
  })

  it('真实执行异常保留原错误和未执行的输入，重试可以完成', async () => {
    const h = setup()
    const error = new Error('validation-command-failed')
    vi.spyOn(h.commands, 'syncExecuteCommand').mockImplementationOnce(() => {
      throw error
    })
    h.setting()
    h.option()
    await expect(h.tick()).rejects.toBe(error)
    expect(h.current()).toMatchObject({ allowBlank: true, errorStyle: 2 })
    fireEvent.click(screen.getByText('确认'))
    expect(h.current()).toMatchObject({ allowBlank: false, errorStyle: 1 })
    expect(h.close).toHaveBeenCalledWith(null)
  })

  it('其他单元的撤销不取消本规则的未提交输入', async () => {
    const h = setup()
    h.setting()
    act(() => {
      h.createWorkbook('other')
      h.instances.focusUnit('other')
    })
    await act(async () => {
      expect(await h.commands.executeCommand(UndoCommand.id)).toBe(false)
    })
    await h.tick()
    expect(h.current().allowBlank).toBe(false)
  })
})
