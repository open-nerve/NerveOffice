/**
 * 真实组件链的受控机制回归；原 observed01 的有效 RED 和两项正对照保留。
 * 使用真实 DocEventManager、popup controller/service、文档/工作簿和历史命令。
 * 只在真实 manager 的发布边界投递来自真实正文的旧事件对象；不复制 RxJS 策略。
 * Canvas/bridge 是输入端口，因此本文件不证明真实指针命中或原 Linux CI 触发顺序。
 */
import type { DocumentDataModel, ICustomRange, IDisposable, IDocumentData, Workbook } from '@univerjs/core'
import type { SheetsHyperLinkPopupService } from '@univerjs/sheets-hyper-link-ui'
import { CustomRangeType, DOCS_NORMAL_EDITOR_UNIT_ID_KEY, EDITOR_ACTIVATED, EventSubject, FOCUSING_FX_BAR_EDITOR, FOCUSING_SHEET, ICommandService, IContextService, IUndoRedoService, IUniverInstanceService, RedoCommand, UndoCommand, Univer, UniverInstanceType } from '@univerjs/core'
import { DocEventManagerService } from '@univerjs/docs-ui'
import { SetRangeValuesMutation } from '@univerjs/sheets'
import { CancelRichHyperLinkCommand } from '@univerjs/sheets-hyper-link'
import { ISheetsHyperLinkPopupService, UniverSheetsHyperLinkMobileUIPlugin, UniverSheetsHyperLinkUIPlugin } from '@univerjs/sheets-hyper-link-ui'
import { HoverRenderController, SheetSkeletonManagerService } from '@univerjs/sheets-ui'
import { BehaviorSubject, NEVER, Subject } from 'rxjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { injectorOf } from './injector.ts'

const BOOK = 'link-cache-replay-book'
const SHEET = 'sheet'
const DOC = DOCS_NORMAL_EDITOR_UNIT_ID_KEY
const OLD = 'before-update-range'
const CURRENT = 'after-update-range'
const owner = { unitId: BOOK, subUnitId: SHEET, row: 2, col: 1 }
const rect = { left: 10, top: 10, right: 80, bottom: 30 }
const dispose: (() => void)[] = []

interface Hover {
  range: ICustomRange
  segmentId?: string
  segmentPageIndex: number
  rects: typeof rect[]
}

function content(current = false): IDocumentData {
  const text = current ? '更新富文本' : '富文本资料'
  return {
    id: 'b3-cell-document',
    documentStyle: {},
    body: {
      dataStream: `${text}\r\n`,
      paragraphs: [{ startIndex: text.length, paragraphId: 'link-paragraph' }],
      sectionBreaks: [{ startIndex: text.length + 1, sectionId: 'link-section' }],
      customRanges: [{
        rangeId: current ? CURRENT : OLD,
        rangeType: CustomRangeType.HYPERLINK,
        startIndex: 0,
        endIndex: text.length - 1,
        properties: { url: current ? 'https://example.invalid/rich' : '/spaces' },
      }],
    },
  }
}

function fixture(mobile = false) {
  const univer = new Univer()
  dispose.push(() => univer.dispose())
  const injector = injectorOf(univer)
  const commands = injector.get(ICommandService)
  const instances = injector.get(IUniverInstanceService)
  const history = injector.get(IUndoRedoService)
  const context = injector.get(IContextService)
  for (const command of [SetRangeValuesMutation, CancelRichHyperLinkCommand]) {
    const registration = commands.registerCommand(command)
    dispose.push(() => registration.dispose())
  }
  const workbook = univer.createUnit<unknown, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id: BOOK,
    sheetOrder: [SHEET],
    sheets: { [SHEET]: { id: SHEET, name: 'Sheet', rowCount: 20, columnCount: 10, cellData: { 2: { 1: { p: content() } } } } },
  })
  const doc = univer.createUnit<unknown, DocumentDataModel>(UniverInstanceType.UNIVER_DOC, { ...content(), id: DOC })
  const worksheet = workbook.getSheetBySheetId(SHEET)!
  const cell = () => worksheet.getCellRaw(2, 1)?.p

  // 只实现画布订阅/挂载端口；没有改写 manager、比较器或控制器逻辑。
  const event = () => {
    const subject = new EventSubject<Record<string, unknown>>()
    dispose.push(() => subject.complete())
    return subject
  }
  let cursor = 'text'
  const scene = {
    onTransformChange$: event(),
    onPointerMove$: event(),
    onPointerEnter$: event(),
    onPointerUp$: event(),
    getCursor: () => cursor,
    setCursor: (value: string) => { cursor = value },
  }
  const engine = { onTransformChange$: event(), getCanvasElement: () => ({ getBoundingClientRect: () => rect }) }
  const mainComponent = { onPointerDown$: event() }
  const dirty$ = new Subject<boolean>()
  dispose.push(() => dirty$.complete())
  const manager = new DocEventManagerService(
    { unit: doc, scene, engine, mainComponent } as never,
    { getSkeleton: () => ({ dirty$ }) } as never,
  )
  dispose.push(() => manager.dispose())
  let lastHover: Hover[] = []
  const hoverEmissions: Hover[][] = []
  const hoverObserver = manager.hoverCustomRanges$.subscribe((value) => {
    lastHover = value
    hoverEmissions.push(value)
  })
  dispose.push(() => hoverObserver.unsubscribe())

  const editState = () => ({
    editorUnitId: DOC,
    unitId: BOOK,
    sheetId: SHEET,
    row: 2,
    column: 1,
    documentLayoutObject: { documentModel: doc },
  })
  const state$ = new BehaviorSubject(editState())
  const visible$ = new BehaviorSubject({ visible: false })
  dispose.push(() => {
    state$.complete()
    visible$.complete()
  })
  const bridge = {
    currentEditCellState$: state$,
    visible$,
    isVisible: () => visible$.value,
    getEditCellState: () => state$.value,
    getCurrentEditorId: () => DOC,
  }
  const sheetRender = { with: (token: unknown) => {
    if (token === HoverRenderController)
      return { active: true }
    if (token === SheetSkeletonManagerService)
      return { getSkeletonParam: () => ({ skeleton: { overflowCache: { forValue() {} } } }) }
    throw new Error('未声明的工作表渲染依赖')
  } }
  const docRender = { engine, with: (token: unknown) => {
    if (token === DocEventManagerService)
      return manager
    throw new Error('未声明的正文渲染依赖')
  } }
  const renders = { getRenderUnitById: (id: string) => id === DOC ? docRender : id === BOOK ? sheetRender : null }

  // 沿既有 link-popup-lifecycle.test.ts，从实际插件登记获取真实类。
  const dependencies: unknown[][] = []
  const Plugin = mobile ? UniverSheetsHyperLinkMobileUIPlugin : UniverSheetsHyperLinkUIPlugin
  const plugin = new Plugin({}, { add: (entry: unknown[]) => dependencies.push(entry), get: () => ({}) } as never, { setConfig: () => {} } as never)
  dispose.push(() => plugin.dispose())
  plugin.onStarting()
  const Controller = dependencies.find(([token]) => typeof token === 'function' && token.name === (mobile ? 'SheetsHyperLinkMobilePopupController' : 'SheetsHyperLinkPopupController'))?.[0] as new (...args: unknown[]) => IDisposable
  const entry = dependencies.find(([token]) => token === ISheetsHyperLinkPopupService)?.[1] as { useClass: typeof SheetsHyperLinkPopupService }
  expect(Controller).toBeTypeOf('function')
  expect(entry.useClass).toBeTypeOf('function')
  const attach = () => ({ canDispose: () => true, dispose() {} })
  const PopupService = entry.useClass
  const popups = new PopupService(
    { attachPopupByPosition: attach, attachPopupToAbsolutePosition: attach, attachPopupToCell: attach } as never,
    injector,
    instances,
    bridge as never,
    { getActiveTextRange: () => null, replaceDocRanges() {} } as never,
    renders as never,
    { open() {}, close() {} } as never,
  )
  dispose.push(() => popups.dispose())
  const controller = new Controller(
    { currentRichText$: NEVER, currentClickedCell$: NEVER },
    popups,
    renders,
    { composePermission: () => [{ value: true }] },
    { permissionCheckWithRanges: () => true },
    commands,
    bridge,
    { textSelection$: NEVER },
    instances,
  )
  dispose.push(() => controller.dispose())
  const executed: string[] = []
  const commandObserver = commands.onCommandExecuted(command => executed.push(command.id))
  dispose.push(() => commandObserver.dispose())

  const publishCurrentRange = (range = doc.getBody()!.customRanges![0]!) => {
    const payload: Hover[] = [{ range, segmentPageIndex: -1, rects: [rect] }]
    // 唯一受控发布边界：真实对象、真实 subject；不替换公开 observable。
    const publisher = manager as unknown as { _hoverCustomRanges$: Subject<Hover[]>, _clickCustomRanges$: Subject<Hover> }
    if (mobile)
      publisher._clickCustomRanges$.next(payload[0]!)
    else publisher._hoverCustomRanges$.next(payload)
    return range
  }
  const publishHover = (ranges: Hover[]) => {
    (manager as unknown as { _hoverCustomRanges$: Subject<Hover[]> })._hoverCustomRanges$.next(ranges)
  }
  const syncDocFromCell = () => {
    const current = cell()
    expect(current?.body?.customRanges).toHaveLength(1)
    doc.reset({ ...structuredClone(current!), id: DOC })
    // 模拟正常重排已通知 dirty 的最有利条件；它仍不等价于新的 pointer 事件。
    dirty$.next(true)
    state$.next(editState())
  }
  const replaceUndoRedo = async () => {
    const previous = structuredClone(cell()!)
    const next = content(true)
    const params = (p: IDocumentData) => ({ unitId: BOOK, subUnitId: SHEET, cellValue: { 2: { 1: { p } } } })
    expect(commands.syncExecuteCommand(SetRangeValuesMutation.id, params(next))).toBe(true)
    // 用实际历史服务登记一对实际 mutation；不声称执行了 UpdateRich 的历史生成 UI。
    history.pushUndoRedo({
      unitID: BOOK,
      undoMutations: [{ id: SetRangeValuesMutation.id, params: params(previous) }],
      redoMutations: [{ id: SetRangeValuesMutation.id, params: params(next) }],
    })
    syncDocFromCell()
    instances.focusUnit(BOOK)
    context.setContextValue(FOCUSING_SHEET, true)
    context.setContextValue(EDITOR_ACTIVATED, false)
    context.setContextValue(FOCUSING_FX_BAR_EDITOR, false)
    expect(await commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(cell()?.body?.customRanges?.[0]).toMatchObject({ rangeId: OLD, properties: { url: '/spaces' } })
    expect(history.getUndoRedoStatus(BOOK)).toEqual({ undos: 0, redos: 1 })
    syncDocFromCell()
    expect(await commands.executeCommand(RedoCommand.id)).toBe(true)
    expect(cell()?.body?.customRanges?.[0]).toMatchObject({ rangeId: CURRENT, properties: { url: 'https://example.invalid/rich' } })
    expect(history.getUndoRedoStatus(BOOK)).toEqual({ undos: 1, redos: 0 })
    syncDocFromCell()
    expect(doc.getBody()?.customRanges?.[0]).toMatchObject({ rangeId: CURRENT, properties: { url: 'https://example.invalid/rich' } })
  }
  return {
    doc,
    cell,
    popups,
    commands,
    executed,
    manager,
    scene,
    lastHover: () => lastHover,
    hoverEmissions,
    publishHover,
    enter: () => visible$.next({ visible: true }),
    leave: () => visible$.next({ visible: false }),
    publishCurrentRange,
    replaceUndoRedo,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  try {
    dispose.splice(0).reverse().forEach(cleanup => cleanup())
  }
  finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

describe('真实 Docs 事件缓存与同格正文换代（受控回归）', () => {
  it('当前正文的有效悬停首次重放仍应正常打开菜单，不能简单跳过第一条', () => {
    const f = fixture()
    const realRange = f.publishCurrentRange()
    expect(f.popups.currentPopup).toBeNull()
    f.enter()
    vi.advanceTimersByTime(201)
    expect(f.popups.currentPopup).toMatchObject({ ...owner, type: 'editing', customRange: { rangeId: OLD, properties: { url: '/spaces' } } })
    expect(f.popups.currentPopup?.customRange).toBe(realRange)
    expect(f.doc.getBody()?.customRanges?.[0]).toBe(realRange)
  })

  it('更新及真实撤销重做后重进同格，旧事件对象不能重新成为可操作菜单', async () => {
    const f = fixture()
    f.enter()
    const oldRange = f.publishCurrentRange()
    vi.advanceTimersByTime(201)
    expect(f.popups.currentPopup?.customRange).toBe(oldRange)
    f.leave()
    expect(f.popups.currentPopup).toBeNull()
    const oldRevision = f.doc.getMutationRevision()
    await f.replaceUndoRedo()
    expect(f.doc.getMutationRevision()).toBeGreaterThan(oldRevision)
    expect(f.doc.getBody()?.customRanges?.[0]).not.toBe(oldRange)
    expect(f.lastHover()[0]?.range).toBe(oldRange)
    f.enter()
    vi.advanceTimersByTime(201)

    // 独立校准实际删除 handler 的旧 ID 分支；不是伪造一次 UI 点击。
    const body = structuredClone(f.doc.getBody())
    const saved = structuredClone(f.cell())
    f.executed.length = 0
    expect(f.commands.syncExecuteCommand(CancelRichHyperLinkCommand.id, {
      ...owner,
      column: owner.col,
      documentId: DOC,
      id: OLD,
    })).toBe(false)
    expect(f.executed).toContain(CancelRichHyperLinkCommand.id)
    expect(f.executed).not.toContain('doc.mutation.rich-text-editing')
    expect(f.doc.getBody()).toEqual(body)
    expect(f.cell()).toEqual(saved)

    const menu = f.popups.currentPopup
    const observed = {
      menuId: menu?.customRange?.rangeId ?? null,
      menuUrl: (menu?.customRange?.properties?.url ?? null) as unknown,
      docIds: f.doc.getBody()?.customRanges?.map(range => range.rangeId),
      b3Ids: f.cell()?.body?.customRanges?.map(range => range.rangeId),
      mutationRevision: f.doc.getMutationRevision(),
    }
    // 允许安全关闭；若仍展示，必须来自当前 Docs，而不是 visible 或同一坐标替代身份。
    expect(observed.menuId, JSON.stringify(observed)).not.toBe(OLD)
    if (menu !== null) {
      expect(menu).toMatchObject({ ...owner, type: 'editing' })
      expect(menu.customRange).toEqual(f.doc.getBody()?.customRanges?.find(range => range.rangeId === menu.customRange?.rangeId))
    }
  })

  it('真实 pointer-enter 清除旧缓存后，当前正文的新悬停仍可正常打开', async () => {
    const f = fixture()
    f.enter()
    f.publishCurrentRange()
    vi.advanceTimersByTime(201)
    f.leave()
    await f.replaceUndoRedo()
    f.scene.onPointerEnter$.emitEvent({})
    expect(f.lastHover()).toEqual([])
    f.enter()
    vi.advanceTimersByTime(201)
    expect(f.popups.currentPopup).toBeNull()
    const currentRange = f.publishCurrentRange()
    vi.advanceTimersByTime(201)
    expect(f.popups.currentPopup).toMatchObject({ ...owner, type: 'editing', customRange: { rangeId: CURRENT, properties: { url: 'https://example.invalid/rich' } } })
    expect(f.popups.currentPopup?.customRange).toBe(currentRange)
  })
})

describe('真实 manager 发布后的正文身份', () => {
  const semanticChanges: [string, (range: ICustomRange) => void][] = [
    ['URL', (range) => { range.properties = { ...range.properties, url: 'https://example.invalid/current' } }],
    ['endIndex', (range) => { range.endIndex -= 1 }],
    ['tooltip', (range) => { range.properties = { ...range.properties, tooltip: 'current tooltip' } }],
    ['XLSX tooltip', (range) => { range.properties = { ...range.properties, _xlsxHyperlinkTooltip: 'current tooltip' } }],
  ]

  it.each(semanticChanges)('同 ID/start 的 %s 更新在真实 manager 中拒绝旧值后，无重置即可交付新值', (_name, change) => {
    const f = fixture()
    f.enter()
    const previous = f.publishCurrentRange()
    vi.advanceTimersByTime(100)
    const next = structuredClone(f.doc.getSnapshot())
    change(next.body!.customRanges![0]!)
    f.doc.reset(next)
    const current = f.doc.getBody()!.customRanges![0]!
    expect(current.rangeId).toBe(previous.rangeId)
    expect(current.startIndex).toBe(previous.startIndex)
    const body = structuredClone(f.doc.getBody())
    f.executed.length = 0
    vi.advanceTimersByTime(101)
    expect(f.popups.currentPopup).toBeNull()
    f.publishCurrentRange()
    vi.advanceTimersByTime(201)
    expect(f.popups.currentPopup).toMatchObject({ ...owner, type: 'editing', customRange: current })
    expect(f.popups.currentPopup?.customRange).toBe(current)
    expect(f.doc.getBody()).toEqual(body)
    expect(f.executed).toEqual([])
  })

  it.each(semanticChanges)('真实范围对象原地修改 %s 后仍产生新的语义事件', (_name, change) => {
    const f = fixture()
    const range = f.publishCurrentRange()
    const before = f.hoverEmissions.length
    change(range)
    f.publishCurrentRange(range)
    expect(f.hoverEmissions).toHaveLength(before + 1)
    expect(f.lastHover()[0]?.range).toBe(range)
  })

  it('语义相同的克隆和 tooltip 等效来源保持去重，空值仍能发布', () => {
    const f = fixture()
    const range = f.doc.getBody()!.customRanges![0]!
    range.properties = { ...range.properties, tooltip: 'tip', _xlsxHyperlinkTooltip: 'unused' }
    f.publishCurrentRange(range)
    const before = f.hoverEmissions.length
    f.publishCurrentRange(structuredClone(range))
    const equivalent = structuredClone(range)
    equivalent.properties = { ...equivalent.properties, tooltip: undefined, _xlsxHyperlinkTooltip: 'tip' }
    f.publishCurrentRange(equivalent)
    expect(f.hoverEmissions).toHaveLength(before)
    f.publishHover([])
    expect(f.hoverEmissions).toHaveLength(before + 1)
    expect(f.lastHover()).toEqual([])
  })

  it('链接变成非链接时通知当前订阅，普通非链接的附加属性不扩大去重语义', () => {
    const f = fixture()
    const link = f.publishCurrentRange()
    const before = f.hoverEmissions.length
    const nonLink = { ...structuredClone(link), rangeType: CustomRangeType.COMMENT }
    f.publishCurrentRange(nonLink)
    expect(f.hoverEmissions).toHaveLength(before + 1)
    f.publishCurrentRange({ ...nonLink, properties: { url: 'irrelevant' } })
    expect(f.hoverEmissions).toHaveLength(before + 1)
  })

  it('连续命中不同范围后离开仍恢复最初 cursor', () => {
    const f = fixture()
    const originalCursor = f.scene.getCursor()
    const range = f.publishCurrentRange()
    expect(f.scene.getCursor()).toBe('pointer')
    f.publishCurrentRange({ ...range, rangeId: 'another-range' })
    expect(f.scene.getCursor()).toBe('pointer')
    f.publishHover([])
    expect(f.scene.getCursor()).toBe(originalCursor)
  })

  it('桌面悬停发布 100 ms 后正文替换，200 ms 消费边界拒绝旧值并接受新悬停', () => {
    const f = fixture()
    f.enter()
    const previous = f.publishCurrentRange()
    vi.advanceTimersByTime(100)
    f.doc.reset({ ...content(true), id: DOC })
    const body = structuredClone(f.doc.getBody())
    f.executed.length = 0
    vi.advanceTimersByTime(101)
    expect(f.popups.currentPopup).toBeNull()
    expect(f.doc.getBody()).toEqual(body)
    expect(f.executed).toEqual([])
    const current = f.publishCurrentRange()
    expect(current).not.toBe(previous)
    vi.advanceTimersByTime(201)
    expect(f.popups.currentPopup).toMatchObject({ type: 'editing', customRange: { rangeId: CURRENT, properties: { url: 'https://example.invalid/rich' } } })
    expect(f.popups.currentPopup?.customRange).toBe(current)
  })

  it('移动真实 click 发布口拒绝旧载荷，随后正常点击展示当前模型对象', () => {
    const f = fixture(true)
    f.enter()
    const previous = f.publishCurrentRange()
    expect(f.popups.currentPopup?.customRange).toBe(previous)
    f.doc.reset({ ...content(true), id: DOC })
    const body = structuredClone(f.doc.getBody())
    f.executed.length = 0
    f.publishCurrentRange(previous)
    expect(f.popups.currentPopup).toBeNull()
    expect(f.doc.getBody()).toEqual(body)
    expect(f.executed).toEqual([])
    const current = f.publishCurrentRange()
    expect(f.popups.currentPopup).toMatchObject({ type: 'editing', customRange: { rangeId: CURRENT, properties: { url: 'https://example.invalid/rich' } } })
    expect(f.popups.currentPopup?.customRange).toBe(current)
  })

  it('当前正文克隆后有效首次缓存重放返回新模型对象，无需新的 pointer', () => {
    const f = fixture()
    const previous = f.publishCurrentRange()
    f.doc.reset(structuredClone(f.doc.getSnapshot()))
    const current = f.doc.getBody()!.customRanges![0]!
    expect(current).not.toBe(previous)
    expect(current).toEqual(previous)
    f.enter()
    vi.advanceTimersByTime(201)
    expect(f.popups.currentPopup).toMatchObject({ type: 'editing', customRange: { rangeId: OLD, properties: { url: '/spaces' } } })
    expect(f.popups.currentPopup?.customRange).toBe(current)
  })
})
