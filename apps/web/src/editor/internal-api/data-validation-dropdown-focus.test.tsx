import type { IDisposable, IWorkbookData, Workbook } from '@univerjs/core'
import type { ISheetLocation } from '@univerjs/sheets'
import type { ComponentType } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { DataValidationType, IConfigService, ILogService, IUniverInstanceService, LocaleService, Univer, UniverInstanceType } from '@univerjs/core'
import { DataValidatorDropdownType } from '@univerjs/data-validation'
import { SetRangeValuesCommand, SheetPermissionCheckController } from '@univerjs/sheets'
import { UniverSheetsDataValidationUIPlugin } from '@univerjs/sheets-data-validation-ui'
import { SetCellEditVisibleOperation, SheetCellDropdownManagerService, UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import { ComponentManager, RediContext } from '@univerjs/ui'
import { Subject } from 'rxjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { injectorOf } from './injector.ts'

vi.hoisted(() => vi.stubGlobal('Path2D', class {}))

interface ListProps {
  location: ISheetLocation
  hideFn: () => void
  options: { label: string, value: string }[]
  onChange?: (value: string[]) => boolean | Promise<boolean>
  defaultValue?: string
  multiple?: boolean
  showSearch?: boolean
  autoFocusSearch?: boolean
}
interface Popup {
  componentKey: string
  extraProps: ListProps
  anchorRect?: { left: number, right: number }
}
interface ValidationManager extends IDisposable {
  showDropdown: (param: { location: ISheetLocation, trigger?: 'editor-bridge' }) => void
  hideDropdown: () => void
}

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(dispose => dispose())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup(multiple = false) {
  vi.useFakeTimers()
  const univer = new Univer()
  cleanups.push(() => univer.dispose())
  const injector = injectorOf(univer)
  const instances = injector.get(IUniverInstanceService)
  vi.spyOn(injector.get(LocaleService), 't').mockImplementation(key => key)
  const workbook = univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id: 'focus-wb',
    sheetOrder: ['s1'],
    sheets: { s1: { id: 's1', name: 'Sheet1', rowCount: 10, columnCount: 10, cellData: { 2: { 2: { v: 'blue' } } } } },
  })
  const worksheet = workbook.getActiveSheet()
  const location: ISheetLocation = { workbook, worksheet, unitId: workbook.getUnitId(), subUnitId: worksheet.getSheetId(), row: 2, col: 2 }
  const components = new ComponentManager(injector.get(ILogService))
  injector.add([ComponentManager, { useValue: components }])
  injector.add([SheetPermissionCheckController, { useValue: { permissionCheckWithRanges: () => true } as never }])
  const dependencies: unknown[][] = []
  // 与详情面板回归相同：执行发布包插件登记，取得真实服务 token 和组件；没有复制 manager/组件的焦点逻辑。
  const registration = {
    add: (entry: unknown[]) => { dependencies.push(entry) },
    get: (token: unknown) => {
      const Controller = token as new (...args: unknown[]) => IDisposable
      if (Controller.name === 'ComponentsController') {
        const controller = new Controller(components, { register: () => ({ dispose() {} }) }, injector)
        cleanups.push(() => controller.dispose())
      }
      return {}
    },
  }
  const sheets = new UniverSheetsUIPlugin({}, registration as never, { registerRenderModule: () => ({ dispose() {} }) } as never, injector.get(IConfigService), instances)
  cleanups.push(() => sheets.dispose())
  sheets.onStarting()
  const validation = new UniverSheetsDataValidationUIPlugin({}, registration as never, { registerCommand() {} } as never, injector.get(IConfigService))
  cleanups.push(() => validation.dispose())
  validation.onStarting()
  const Manager = dependencies.find(([token]) => typeof token === 'function' && token.name === 'DataValidationDropdownManagerService')?.[0] as new (...args: unknown[]) => ValidationManager
  expect(Manager, '实际数据验证插件必须登记 manager').toBeDefined()
  const List = components.get('sheets.dropdown.list') as ComponentType<{ popup: Popup }>
  expect(List, '实际 sheets-ui 插件必须登记 ListDropDown').toBeDefined()

  const editor = document.createElement('textarea')
  editor.setAttribute('aria-label', '单元格编辑器')
  document.body.append(editor)
  cleanups.push(() => editor.remove())
  editor.focus()
  const searchFocus: EventTarget[] = []
  const observe = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.matches('[data-u-comp="sheets-dropdown-list"] input'))
      searchFocus.push(event.target)
  }
  document.addEventListener('focusin', observe)
  cleanups.push(() => document.removeEventListener('focusin', observe))
  const focus = vi.spyOn(HTMLElement.prototype, 'focus') // 记录且仍调用原生 focus，包括已卸载 input。
  let popup!: Popup
  let view: ReturnType<typeof render> | undefined
  const closed = vi.fn()
  const mount = () => <RediContext value={{ injector }}><List popup={popup} /></RediContext>
  const cell = new SheetCellDropdownManagerService({
    // 仅替代画布坐标和挂载端口；popup/extraProps 全部由真实第二层 manager 生成。
    attachPopupToCell: (_row: number, _col: number, next: Popup) => {
      popup = { ...next, anchorRect: { left: 0, right: 100 } }
      view = render(mount())
      return { dispose: () => {
        view?.unmount()
        closed()
      } }
    },
  } as never, { getRenderUnitById: () => null } as never)
  cleanups.push(() => {
    view?.unmount()
    cell.dispose()
  })
  const selectionMoveEnd$ = new Subject<unknown[]>()
  cleanups.push(() => selectionMoveEnd$.complete())
  const rule = { uid: 'focus-list', type: multiple ? DataValidationType.LIST_MULTIPLE : DataValidationType.LIST }
  const model = { getRuleByLocation: () => rule }
  const command = vi.fn(async (_id: string, _params: unknown) => true)
  const manager = new Manager(instances, {
    getValidatorItem: () => ({
      dropdownType: multiple ? DataValidatorDropdownType.MULTIPLE_LIST : DataValidatorDropdownType.LIST,
      getListWithColor: () => [{ label: 'green' }, { label: 'blue' }],
    }),
  }, model, { selectionMoveEnd$ }, cell, model, { executeCommand: command }, { isVisible: () => ({ visible: true }) }, injector, injector.get(IConfigService))
  cleanups.push(() => {
    manager.hideDropdown()
    manager.dispose()
  })
  const tick = async () => act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  const open = (trigger?: 'editor-bridge') => act(() => manager.showDropdown({ location, ...trigger ? { trigger } : {} }))
  const change = vi.fn(async () => !multiple)
  const openDefault = async (showSearch = true) => act(() => cell.showDropdown({
    location,
    type: 'list',
    props: { options: [{ label: 'green', value: 'green' }, { label: 'blue', value: 'blue' }], defaultValue: 'blue', multiple, showSearch, onChange: change },
  }))
  const rerender = (props: Partial<ListProps>) => {
    popup = { ...popup, extraProps: { ...popup.extraProps, ...props } }
    view!.rerender(mount())
  }
  const search = () => document.querySelector<HTMLInputElement>('[data-u-comp="sheets-dropdown-list"] input')!
  const filterAndChoose = async () => {
    fireEvent.change(search(), { target: { value: 'gre' } })
    expect(search()).toHaveValue('gre')
    expect(screen.queryByText('blue', { exact: true })).not.toBeInTheDocument()
    const option = screen.getByText((_content, node) => node?.textContent === 'green' && node.children.length === 2)
    await act(async () => {
      fireEvent.click(option)
    })
  }
  return { editor, search, searchFocus, focus, open, openDefault, tick, rerender, filterAndChoose, command, change, closed, unmount: () => view!.unmount() }
}

describe('列表搜索自动聚焦的真实 manager → popup → 组件链', () => {
  it.each([false, true])('editor-bridge 的列表从提交至 timer 后从未自动抢焦点（多选：%s）', async (multiple) => {
    const h = setup(multiple)
    h.open('editor-bridge')
    await h.tick()
    expect(h.search()).toHaveValue('')
    expect(h.searchFocus).toEqual([])
    expect(document.activeElement).toBe(h.editor)
  })

  it.each([false, true])('显式入口仍自动聚焦并执行真实过滤、选择和关闭语义（多选：%s）', async (multiple) => {
    const h = setup(multiple)
    h.open()
    await h.tick()
    expect(document.activeElement).toBe(h.search())
    expect(h.searchFocus).toEqual([h.search()])
    await h.filterAndChoose()
    expect(h.command).toHaveBeenCalledWith(SetRangeValuesCommand.id, {
      unitId: 'focus-wb',
      subUnitId: 's1',
      range: { startColumn: 2, endColumn: 2, startRow: 2, endRow: 2 },
      value: { v: multiple ? '["green","blue"]' : 'green', p: null, f: null, si: null },
    })
    expect(h.command).toHaveBeenCalledWith(SetCellEditVisibleOperation.id, expect.objectContaining({ visible: false, unitId: 'focus-wb' }))
    expect(h.closed).toHaveBeenCalledTimes(multiple ? 0 : 1)
    expect(h.search() !== null).toBe(multiple)
  })

  it.each([false, true])('缺省属性继续自动聚焦、过滤和回调（多选：%s）', async (multiple) => {
    const h = setup(multiple)
    await h.openDefault()
    await h.tick()
    expect(document.activeElement).toBe(h.search())
    await h.filterAndChoose()
    expect(h.change).toHaveBeenCalledExactlyOnceWith(multiple ? ['green', 'blue'] : ['green'])
    expect(h.closed).toHaveBeenCalledTimes(multiple ? 0 : 1)
  })

  it.each([false, true])('联动列表允许用户主动进入搜索并选择（多选：%s）', async (multiple) => {
    const h = setup(multiple)
    h.open('editor-bridge')
    await h.tick()
    expect(h.searchFocus).toEqual([])
    h.search().focus()
    expect(document.activeElement).toBe(h.search())
    await h.filterAndChoose()
    expect(h.command.mock.calls.find(([id]) => id === SetRangeValuesCommand.id)?.[1]).toMatchObject({ value: { v: multiple ? '["green","blue"]' : 'green' } })
    expect(h.closed).toHaveBeenCalledTimes(multiple ? 0 : 1)
  })

  it.each(['unmount', 'hide-search', 'disable-auto-focus'] as const)('%s 会取消旧 timer，不触及用户新焦点', async (action) => {
    const h = setup()
    h.open()
    const oldSearch = h.search()
    expect(document.activeElement).toBe(oldSearch)
    if (action === 'unmount')
      h.unmount()
    else
      h.rerender(action === 'hide-search' ? { showSearch: false } : { autoFocusSearch: false })
    h.editor.focus()
    h.focus.mockClear()
    await h.tick()
    expect(h.focus.mock.instances).not.toContain(oldSearch)
    expect(document.activeElement).toBe(h.editor)
    if (action === 'hide-search')
      expect(h.search()).toBeNull()
  })

  it('showSearch=false 不创建搜索，也不执行自动聚焦', async () => {
    const h = setup()
    await h.openDefault(false)
    await h.tick()
    expect(h.search()).toBeNull()
    expect(h.searchFocus).toEqual([])
    expect(document.activeElement).toBe(h.editor)
  })

  it.each([undefined, 'editor-bridge'] as const)('重建实例不受已销毁实例的 timer 影响（来源：%s）', async (trigger) => {
    const h = setup()
    h.open()
    const oldSearch = h.search()
    h.unmount()
    h.editor.focus()
    h.searchFocus.length = 0
    h.focus.mockClear()
    h.open(trigger)
    const nextSearch = h.search()
    await h.tick()
    expect(nextSearch).not.toBe(oldSearch)
    expect(h.focus.mock.instances).not.toContain(oldSearch)
    expect(h.searchFocus).toEqual(trigger ? [] : [nextSearch])
    expect(document.activeElement).toBe(trigger ? h.editor : nextSearch)
  })
})
