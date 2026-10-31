import type { ICustomRange, IDisposable } from '@univerjs/core'
import type { SheetsHyperLinkPopupService } from '@univerjs/sheets-hyper-link-ui'
import { CustomRangeType, DOCS_NORMAL_EDITOR_UNIT_ID_KEY, DocumentDataModel, ICommandService, Univer, UniverInstanceType } from '@univerjs/core'
import { DocEventManagerService } from '@univerjs/docs-ui'
import { WorkbookViewPermission } from '@univerjs/sheets'
import { ISheetsHyperLinkPopupService, UniverSheetsHyperLinkMobileUIPlugin, UniverSheetsHyperLinkUIPlugin } from '@univerjs/sheets-hyper-link-ui'
import { HoverRenderController, SheetSkeletonManagerService } from '@univerjs/sheets-ui'
import { BehaviorSubject, NEVER, Subject } from 'rxjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { injectorOf } from './injector.ts'

const location = { unitId: 'workbook', subUnitId: 'sheet', row: 2, col: 1 }
const range: ICustomRange = { rangeId: 'middle-link', rangeType: CustomRangeType.HYPERLINK, startIndex: 2, endIndex: 6, properties: { url: '/spaces' } }
const rect = { left: 10, top: 10, right: 80, bottom: 30 }
const cell = { ...location, customRange: range, rect }
const editState = {
  editorUnitId: DOCS_NORMAL_EDITOR_UNIT_ID_KEY,
  unitId: 'workbook',
  sheetId: 'sheet',
  row: 2,
  column: 1,
  documentLayoutObject: { documentModel: { getBody: () => ({ dataStream: '前文富文本资料后文\r\n', customRanges: [range] }) } },
}
interface DocRange {
  range: ICustomRange
  segmentId?: string | null
  rects: typeof rect[]
}

/** 使用发布包的实际 controller + popup service；只替代画布挂载和工作表读取。 */
function fixture(mobile: boolean, editable = true) {
  const doc = new DocumentDataModel({ id: DOCS_NORMAL_EDITOR_UNIT_ID_KEY, body: structuredClone(editState.documentLayoutObject.documentModel.getBody()) })
  const univer = new Univer()
  const commands = injectorOf(univer).get(ICommandService)
  const executed: string[] = []
  const commandObserver = commands.onCommandExecuted(command => executed.push(command.id))
  let currentDoc: DocumentDataModel | null = doc
  const dependencies: unknown[][] = []
  const Plugin = mobile ? UniverSheetsHyperLinkMobileUIPlugin : UniverSheetsHyperLinkUIPlugin
  const plugin = new Plugin({}, { add: (entry: unknown[]) => dependencies.push(entry), get: () => ({}) } as never, { setConfig: () => {} } as never)
  plugin.onStarting()
  const name = mobile ? 'SheetsHyperLinkMobilePopupController' : 'SheetsHyperLinkPopupController'
  const Controller = dependencies.find(([token]) => typeof token === 'function' && token.name === name)?.[0] as new (...args: unknown[]) => IDisposable
  const serviceEntry = dependencies.find(([token]) => token === ISheetsHyperLinkPopupService)?.[1] as { useClass: typeof SheetsHyperLinkPopupService }
  expect(Controller).toBeTypeOf('function')
  expect(serviceEntry.useClass).toBeTypeOf('function')

  const sheetHover$ = new Subject<typeof cell | null>()
  const sheetClick$ = new Subject<{ location: typeof location, customRange: ICustomRange, rect: typeof rect } | null>()
  const docHover$ = new Subject<DocRange[]>()
  const docClick$ = new Subject<DocRange>()
  const state$ = new BehaviorSubject<typeof editState | null>(editState)
  const visible$ = new BehaviorSubject({ visible: false })
  const bridge = { currentEditCellState$: state$, visible$, isVisible: () => visible$.value, getEditCellState: () => state$.value }
  const worksheet = { getCellRaw: () => ({ p: { body: { dataStream: '前文富文本资料后文\r\n', customRanges: [range] } } }), getCell: () => worksheet.getCellRaw(), getCellStyleOnly: () => ({}) }
  const workbook = { getSheetBySheetId: () => worksheet, getStyles: () => ({ getStyleByCell: () => ({}) }) }
  const units = { getUnit: (id: string, type: UniverInstanceType) => {
    if (type === UniverInstanceType.UNIVER_DOC)
      return id === DOCS_NORMAL_EDITOR_UNIT_ID_KEY ? currentDoc : null
    if (type === UniverInstanceType.UNIVER_SHEET && ['workbook', 'another-book'].includes(id))
      return workbook
    return null
  } }
  const skeleton = { overflowCache: { forValue() {} } }
  const sheetRender = { with: (token: unknown) => {
    if (token === HoverRenderController)
      return { active: true }
    if (token === SheetSkeletonManagerService)
      return { getSkeletonParam: () => ({ skeleton }) }
    throw new Error('未声明的工作表渲染依赖')
  } }
  const docRender = { with: (token: unknown) => {
    if (token === DocEventManagerService)
      return { hoverCustomRanges$: docHover$, clickCustomRanges$: docClick$ }
    throw new Error('未声明的正文渲染依赖')
  }, engine: { getCanvasElement: () => ({ getBoundingClientRect: () => rect }) } }
  const renders = { getRenderUnitById: (id: string) => id === DOCS_NORMAL_EDITOR_UNIT_ID_KEY ? docRender : sheetRender }
  let canDispose = true
  const attach = () => ({ canDispose: () => canDispose, dispose() {} })
  const PopupService = serviceEntry.useClass
  const popups = new PopupService(
    { attachPopupByPosition: attach, attachPopupToAbsolutePosition: attach, attachPopupToCell: attach } as never,
    {} as never,
    units as never,
    bridge as never,
    { getActiveTextRange: () => null, replaceDocRanges() {} } as never,
    renders as never,
    { open() {}, close() {} } as never,
  )
  const instance = new Controller(
    { currentRichText$: sheetHover$, currentClickedCell$: sheetClick$ },
    popups,
    renders,
    { composePermission: () => [{ value: true }] },
    { permissionCheckWithRanges: (check: { workbookTypes: unknown[] }) => check.workbookTypes.includes(WorkbookViewPermission) || editable },
    commands,
    bridge,
    { textSelection$: NEVER },
    units,
  )
  const sheetEvent = (hasLink = true) => {
    if (mobile)
      sheetClick$.next(hasLink ? { location, customRange: range, rect } : null)
    else sheetHover$.next(hasLink ? cell : null)
  }
  const docEvent = (candidate = doc.getBody()!.customRanges![0]!, segmentId?: string | null) => {
    const event: DocRange = { range: candidate, rects: [rect], segmentId }
    if (mobile)
      docClick$.next(event)
    else docHover$.next([event])
  }
  return {
    popups,
    doc,
    executed,
    dropDoc: () => { currentDoc = null },
    replaceRange: (current: ICustomRange) => doc.reset({ ...structuredClone(doc.getSnapshot()), body: { ...structuredClone(doc.getBody()!), customRanges: [structuredClone(current)] } }),
    state$,
    visible$,
    sheetEvent,
    docEvent,
    keepPointerInside: () => { canDispose = false },
    disposeController: () => instance.dispose(),
    dispose: () => {
      instance.dispose()
      popups.dispose()
      plugin.dispose()
      commandObserver.dispose()
      univer.dispose()
      doc.dispose()
    },
  }
}

describe.each([false, true])('固定 SDK 链接菜单所属编辑状态（mobile=%s）', (mobile) => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('进入正文编辑时立即撤掉旧菜单，即使指针仍停在菜单内', () => {
    const f = fixture(mobile)
    try {
      f.sheetEvent()
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup?.type).toBe('viewing')
      f.keepPointerInside()
      f.visible$.next({ visible: true })
      expect(f.popups.currentPopup).toBeNull()
    }
    finally { f.dispose() }
  })

  it.each([true, false])('编辑期间的工作表事件不能替换或关闭正文菜单（有链接=%s）', (hasLink) => {
    const f = fixture(mobile)
    try {
      f.visible$.next({ visible: true })
      f.docEvent()
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup?.type).toBe('editing')
      f.sheetEvent(hasLink)
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup?.type).toBe('editing')
      expect(f.popups.currentPopup?.customRange?.rangeId).toBe('middle-link')
    }
    finally { f.dispose() }
  })

  it.each(['hide', 'clear-state'] as const)('退出编辑或清空活动单元格后取消已排队的正文事件：%s', (exit) => {
    const f = fixture(mobile)
    try {
      f.visible$.next({ visible: true })
      f.docEvent()
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup?.type).toBe('editing')
      f.docEvent()
      if (exit === 'hide')
        f.visible$.next({ visible: false })
      else f.state$.next(null)
      expect(f.popups.currentPopup).toBeNull()
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toBeNull()
    }
    finally { f.dispose() }
  })

  it.each([
    { change: { unitId: 'another-book' }, owner: { unitId: 'another-book', subUnitId: 'sheet', row: 2, col: 1 } },
    { change: { sheetId: 'another-sheet' }, owner: { unitId: 'workbook', subUnitId: 'another-sheet', row: 2, col: 1 } },
    { change: { row: 9 }, owner: { unitId: 'workbook', subUnitId: 'sheet', row: 9, col: 1 } },
    { change: { column: 8 }, owner: { unitId: 'workbook', subUnitId: 'sheet', row: 2, col: 8 } },
  ])('仍在正文编辑时切换所属单元格，旧菜单和排队事件必须失效：$change', ({ change, owner }) => {
    const f = fixture(mobile)
    try {
      f.visible$.next({ visible: true })
      f.docEvent()
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toMatchObject({ ...location, type: 'editing' })
      f.docEvent()
      f.keepPointerInside()
      f.state$.next({ ...editState, ...change })
      expect(f.popups.currentPopup).toBeNull()
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toBeNull()
      f.docEvent()
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toMatchObject({ ...owner, type: 'editing' })
    }
    finally { f.dispose() }
  })

  it('同一单元格的重复状态通知保留当前正文菜单', () => {
    const f = fixture(mobile)
    try {
      f.visible$.next({ visible: true })
      f.docEvent()
      vi.advanceTimersByTime(201)
      const popup = f.popups.currentPopup
      expect(popup?.type).toBe('editing')
      f.state$.next({ ...editState })
      expect(f.popups.currentPopup).toBe(popup)
    }
    finally { f.dispose() }
  })

  it('正文状态变化不会关闭普通链接表单', () => {
    const f = fixture(mobile)
    try {
      f.popups.startAddEditing({ ...location, type: 'viewing' as Parameters<SheetsHyperLinkPopupService['startAddEditing']>[0]['type'] })
      const form = f.popups.currentEditing
      expect(form?.type).toBe('viewing')
      f.state$.next({ ...editState, row: 9 })
      expect(f.popups.currentEditing).toBe(form)
    }
    finally { f.dispose() }
  })

  it.each([true, false])('退出编辑后普通和只读链接菜单仍可查看，权限保持（可编辑=%s）', (editable) => {
    const f = fixture(mobile, editable)
    try {
      f.visible$.next({ visible: true })
      f.docEvent()
      vi.advanceTimersByTime(201)
      f.visible$.next({ visible: false })
      f.sheetEvent()
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toMatchObject({ type: 'viewing', editPermission: editable, copyPermission: true, customRange: { rangeId: 'middle-link' } })
      f.sheetEvent(false)
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toBeNull()
    }
    finally { f.dispose() }
  })

  it('控制器退役后，排队事件和新事件都不能重新打开菜单', () => {
    const f = fixture(mobile)
    try {
      f.visible$.next({ visible: true })
      f.docEvent()
      f.disposeController()
      f.popups.hideCurrentPopup(undefined, true)
      f.sheetEvent()
      f.docEvent()
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toBeNull()
    }
    finally { f.dispose() }
  })
})

describe('真实移动端链接表单的所属单元格', () => {
  it.each([false, true])('切换单元格后结束旧正文表单，同时尊重范围选择器保留状态（keepVisible=%s）', (keepVisible) => {
    const f = fixture(true)
    try {
      f.visible$.next({ visible: true })
      f.popups.startAddEditing({ ...location, type: 'editing' as Parameters<SheetsHyperLinkPopupService['startAddEditing']>[0]['type'] })
      const form = f.popups.currentEditing
      expect(form).toMatchObject({ ...location, type: 'editing', label: '前文富文本资料后文' })
      f.state$.next({ ...editState })
      expect(f.popups.currentEditing).toBe(form)
      f.popups.setIsKeepVisible(keepVisible)
      f.state$.next({ ...editState, row: 9 })
      expect(f.popups.currentEditing).toBe(keepVisible ? form : null)
      f.popups.setIsKeepVisible(false)
      f.popups.endEditing()
      expect(f.popups.currentEditing).toBeNull()
    }
    finally { f.dispose() }
  })
})

it('已经排队的工作表悬停在进入编辑后也不能短暂重开旧菜单', () => {
  vi.useFakeTimers()
  const f = fixture(false)
  try {
    f.sheetEvent()
    vi.advanceTimersByTime(100)
    f.visible$.next({ visible: true })
    const types: unknown[] = []
    const subscription = f.popups.currentPopup$.subscribe(popup => types.push(popup?.type))
    try {
      f.docEvent()
      vi.advanceTimersByTime(201)
      expect(types).not.toContain('viewing')
      expect(f.popups.currentPopup?.type).toBe('editing')
    }
    finally { subscription.unsubscribe() }
  }
  finally {
    f.dispose()
    vi.useRealTimers()
  }
})

describe.each([false, true])('当前 Docs 链接身份边界（mobile=%s）', (mobile) => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([
    { name: '当前 Doc 不存在', change: 'missing-doc', segment: undefined },
    { name: '当前 body 不存在', change: 'missing-body', segment: undefined },
    { name: '未知 segment 与 body 同 ID', change: 'none', segment: 'unknown-segment' },
    { name: 'header segment 与 body 同 ID', change: 'none', segment: 'header' },
    { name: 'footer segment 与 body 同 ID', change: 'none', segment: 'footer' },
    { name: 'null segment 不能回退 body', change: 'none', segment: null },
    { name: '事件 ID 不在当前正文', change: 'missing-id', segment: undefined },
    { name: '当前同 ID 已不是链接', change: 'not-hyperlink', segment: undefined },
  ])('$name：旧事件不能显示 editing 菜单或写正文', ({ change, segment }) => {
    const f = fixture(mobile)
    try {
      f.visible$.next({ visible: true })
      const previous = f.doc.getBody()!.customRanges![0]!
      if (change === 'missing-doc')
        f.dropDoc()
      else if (change === 'missing-body')
        f.doc.reset({ id: DOCS_NORMAL_EDITOR_UNIT_ID_KEY })
      else if (change === 'missing-id')
        f.replaceRange({ ...previous, rangeId: 'current-link' })
      else if (change === 'not-hyperlink')
        f.replaceRange({ ...previous, rangeType: CustomRangeType.CUSTOM })
      f.popups.startAddEditing({ ...location, type: 'viewing' as Parameters<SheetsHyperLinkPopupService['startAddEditing']>[0]['type'] })
      const form = f.popups.currentEditing
      expect(form?.type).toBe('viewing')
      const body = structuredClone(f.doc.getBody())
      const revision = f.doc.getMutationRevision()
      f.docEvent(previous, segment)
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toBeNull()
      expect(f.popups.currentEditing).toBe(form)
      expect(f.executed).toEqual([])
      expect(f.doc.getBody()).toEqual(body)
      expect(f.doc.getMutationRevision()).toBe(revision)
    }
    finally { f.dispose() }
  })

  it('非法正文事件不关闭已经显示的 viewing 菜单或普通表单', () => {
    const f = fixture(mobile)
    try {
      f.visible$.next({ visible: true })
      f.popups.startAddEditing({ ...location, row: 9, type: 'viewing' as Parameters<SheetsHyperLinkPopupService['startAddEditing']>[0]['type'] })
      const form = f.popups.currentEditing
      f.popups.showPopup({ ...location, customRange: range, customRangeRect: rect, type: 'viewing' as Parameters<SheetsHyperLinkPopupService['showPopup']>[0]['type'] })
      const viewing = f.popups.currentPopup
      expect(viewing?.type).toBe('viewing')
      f.docEvent(f.doc.getBody()!.customRanges![0], 'unknown-segment')
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toBe(viewing)
      expect(f.popups.currentEditing).toBe(form)
      expect(f.executed).toEqual([])
    }
    finally { f.dispose() }
  })

  const semanticChanges: { name: string, previous: Partial<ICustomRange>, current: Partial<ICustomRange> }[] = [
    { name: 'startIndex', previous: {}, current: { startIndex: 3 } },
    { name: 'endIndex', previous: {}, current: { endIndex: 7 } },
    { name: 'URL', previous: {}, current: { properties: { url: '/spaces/current' } } },
    { name: 'tooltip', previous: { properties: { url: '/spaces', tooltip: '旧提示' } }, current: { properties: { url: '/spaces', tooltip: '当前提示' } } },
    { name: 'xlsx fallback tooltip', previous: { properties: { url: '/spaces', _xlsxHyperlinkTooltip: '旧提示' } }, current: { properties: { url: '/spaces', _xlsxHyperlinkTooltip: '当前提示' } } },
    { name: '空 tooltip 不回退 xlsx', previous: { properties: { url: '/spaces', tooltip: '', _xlsxHyperlinkTooltip: '备选提示' } }, current: { properties: { url: '/spaces', _xlsxHyperlinkTooltip: '备选提示' } } },
  ]

  describe.each(semanticChanges)('同 ID 的 $name 换代', ({ previous: before, current: after }) => {
    it('未显示的旧事件被拒绝，当前正文的新事件正常展示', () => {
      const f = fixture(mobile)
      try {
        f.visible$.next({ visible: true })
        f.replaceRange({ ...range, ...before })
        const previous = f.doc.getBody()!.customRanges![0]!
        f.replaceRange({ ...previous, ...after })
        const current = f.doc.getBody()!.customRanges![0]!
        const body = structuredClone(f.doc.getBody())
        f.docEvent(previous)
        vi.advanceTimersByTime(201)
        expect(f.popups.currentPopup).toBeNull()
        expect(f.doc.getBody()).toEqual(body)
        expect(f.executed).toEqual([])
        f.docEvent(current)
        vi.advanceTimersByTime(201)
        expect(f.popups.currentPopup).toMatchObject({ type: 'editing', editPermission: true, customRange: { ...range, ...before, ...after } })
        expect(f.popups.currentPopup?.customRange).toBe(current)
      }
      finally { f.dispose() }
    })

    it.each(['state', 'event'] as const)('已显示菜单即使不可自行关闭，也在 %s 边界退役并接受当前事件', (boundary) => {
      const f = fixture(mobile)
      try {
        f.visible$.next({ visible: true })
        f.replaceRange({ ...range, ...before })
        f.docEvent()
        vi.advanceTimersByTime(201)
        const stale = f.popups.currentPopup
        expect(stale?.type).toBe('editing')
        // 移动 service 的真实 dialog 默认可关闭；此处只把 UI 挂载的 canDispose 端口固定为 false。
        stale!.disposable.canDispose = () => false
        f.replaceRange({ ...range, ...before, ...after })
        const current = f.doc.getBody()!.customRanges![0]!
        const observed: unknown[] = []
        const subscription = f.popups.currentPopup$.subscribe(popup => observed.push(popup))
        try {
          if (boundary === 'state') {
            f.state$.next({ ...editState })
            expect(f.popups.currentPopup).toBeNull()
          }
          f.docEvent(current)
          vi.advanceTimersByTime(201)
          expect(observed).toContain(null)
          expect(f.popups.currentPopup).not.toBe(stale)
          expect(f.popups.currentPopup).toMatchObject({ type: 'editing', editPermission: true, customRange: { ...range, ...before, ...after } })
          expect(f.popups.currentPopup?.customRange).toBe(current)
          expect(f.executed).toEqual([])
        }
        finally { subscription.unsubscribe() }
      }
      finally { f.dispose() }
    })
  })

  it('有效 tooltip 按 nullish 取值，相同的 xlsx 提示与显式提示属于同一语义', () => {
    const f = fixture(mobile)
    try {
      f.visible$.next({ visible: true })
      f.replaceRange({ ...range, properties: { url: '/spaces', tooltip: null, _xlsxHyperlinkTooltip: '相同提示' } })
      const previous = f.doc.getBody()!.customRanges![0]!
      f.replaceRange({ ...range, properties: { url: '/spaces', tooltip: '相同提示' } })
      const current = f.doc.getBody()!.customRanges![0]!
      f.docEvent(previous)
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toMatchObject({ type: 'editing', customRange: { properties: { url: '/spaces', tooltip: '相同提示' } } })
      expect(f.popups.currentPopup?.customRange).toBe(current)
    }
    finally { f.dispose() }
  })

  it.each([undefined, ''])('语义相同的新正文对象及 body segment=%s 保持有效', (segment) => {
    const f = fixture(mobile)
    try {
      f.visible$.next({ visible: true })
      f.replaceRange({ ...range, properties: { url: '/spaces', tooltip: '', _xlsxHyperlinkTooltip: '未采用旧提示' } })
      const previous = f.doc.getBody()!.customRanges![0]!
      f.replaceRange({ ...previous, properties: { url: '/spaces', tooltip: '', _xlsxHyperlinkTooltip: '未采用新提示' } })
      const current = f.doc.getBody()!.customRanges![0]!
      expect(current).not.toBe(previous)
      f.docEvent(previous, segment)
      vi.advanceTimersByTime(201)
      expect(f.popups.currentPopup).toMatchObject({ type: 'editing', customRange: { rangeId: 'middle-link', properties: { url: '/spaces', tooltip: '' } } })
      expect(f.popups.currentPopup?.customRange).toBe(current)
      const popup = f.popups.currentPopup
      f.doc.reset(structuredClone(f.doc.getSnapshot()))
      f.state$.next({ ...editState })
      expect(f.popups.currentPopup).toBe(popup)
    }
    finally { f.dispose() }
  })
})
