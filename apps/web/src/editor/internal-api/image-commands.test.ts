import type { JSONXActions, Workbook } from '@univerjs/core'
import { CommandType, createDocumentModelWithStyle, Direction, DrawingTypeEnum, ICommandService, ImageSourceType, IUndoRedoService, IUniverInstanceService, JSON1, LocaleType, ObjectRelativeFromH, ObjectRelativeFromV, PositionedObjectLayoutType, RedoCommand, UndoCommand, Univer, UniverInstanceType } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { IDrawingManagerService, UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { CopySheetCommand, DeleteRangeMoveLeftCommand, DeleteRangeMoveUpCommand, InsertRangeMoveDownCommand, InsertRangeMoveRightCommand, InsertRowByRangeCommand, InsertSheetCommand, InsertSheetMutation, MoveRangeCommand, MoveRangeMutation, RemoveColByRangeCommand, RemoveRowByRangeCommand, RemoveSheetCommand, SetRangeValuesCommand, SetRangeValuesMutation, SheetSkeletonService, SheetsSelectionsService, UniverSheetsPlugin } from '@univerjs/sheets'
import { drawingPositionToTransform, ISheetDrawingService, RemoveSheetDrawingCommand, SetDrawingApplyMutation, SetSheetDrawingCommand, SheetDrawingAnchorType, UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorIdentityOverride } from '../identity/editor-authz-io.service.ts'
import { installEntryGuards } from '../profile/entry-guards.ts'
import { installImagePolicy } from '../profile/image-policy.ts'
import { SHEET_ZH_CN } from '../profile/locale.ts'
import { installReadOnlyGuard } from '../read-only/read-only-guard.ts'
import { injectorOf } from './injector.ts'

const SOURCE = '/api/assets/11111111-1111-4111-8111-111111111111'
const OTHER = '/api/assets/22222222-2222-4222-8222-222222222222'
const BOOK = 'image-policy-book'
const SHEET = 'sheet'
const cleanup: (() => void)[] = []
const target = { unitId: BOOK, subUnitId: SHEET, drawingId: 'image' }
const path = [BOOK, SHEET, 'data', 'image']

function setup(source = SOURCE) {
  const univer = new Univer({ locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: SHEET_ZH_CN }, override: editorIdentityOverride('edit') })
  univer.registerPlugin(UniverRenderEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverDrawingPlugin)
  univer.registerPlugin(UniverSheetsDrawingPlugin)
  const api = FUniver.newAPI(univer)
  const guards = installEntryGuards(api)
  const report = vi.fn()
  let editing = true
  const policy = installImagePolicy(univer, api, report, { unitId: BOOK, canEdit: () => editing })
  const workbook = univer.createUnit<unknown, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id: BOOK,
    sheetOrder: [SHEET, 'other'],
    sheets: { [SHEET]: { id: SHEET, name: 'Sheet', rowCount: 20, columnCount: 10 }, other: { id: 'other', name: 'Other', rowCount: 20, columnCount: 10 } },
  })
  const injector = injectorOf(univer)
  injector.get(IUniverInstanceService).focusUnit(BOOK)
  const sheets = injector.get(ISheetDrawingService)
  const drawings = injector.get(IDrawingManagerService)
  const services = [drawings, sheets]
  const drawing = {
    ...target,
    drawingType: DrawingTypeEnum.DRAWING_IMAGE,
    imageSourceType: ImageSourceType.URL,
    source,
    base64Cache: source,
    transform: { left: 0, top: 0, width: 100, height: 100 },
    body: { dataStream: 'a\r\n' },
    docTransform: { size: { width: 100, height: 100 }, angle: 0, positionH: { relativeFrom: ObjectRelativeFromH.PAGE }, positionV: { relativeFrom: ObjectRelativeFromV.PAGE } },
    layoutType: PositionedObjectLayoutType.INLINE,
    anchorType: SheetDrawingAnchorType.Both,
    sheetTransform: { from: { row: 0, column: 0, rowOffset: 0, columnOffset: 0 }, to: { row: 1, column: 1, rowOffset: 0, columnOffset: 0 } },
    axisAlignSheetTransform: { from: { row: 0, column: 0, rowOffset: 0, columnOffset: 0 }, to: { row: 1, column: 1, rowOffset: 0, columnOffset: 0 } },
    altText: 'a',
  }
  for (const service of services) {
    service.setDrawingData(BOOK, SHEET, { image: structuredClone(drawing) })
    service.setDrawingOrder(BOOK, SHEET, ['image'])
  }
  const commands = injector.get(ICommandService)
  const history = injector.get(IUndoRedoService)
  const executed: string[] = []
  const listener = commands.onCommandExecuted(command => executed.push(command.id))
  cleanup.push(() => {
    listener.dispose()
    policy.dispose()
    guards.dispose()
    univer.dispose()
  })
  const state = () => ({
    drawings: services.map(service => structuredClone(service.drawingManagerData)),
    sheetIds: workbook.getSheets().map(sheet => sheet.getSheetId()),
    sizes: workbook.getSheets().map(sheet => [sheet.getRowCount(), sheet.getColumnCount()]),
    styles: structuredClone(workbook.getStyles().toJSON()),
    history: history.getUndoRedoStatus(BOOK),
    revision: workbook.getRev(),
    cells: structuredClone(workbook.getSheets().map(sheet => [sheet.getSheetId(), sheet.getCellMatrix().getMatrix()])),
    executed: [...executed],
  })
  const apply = (op: JSONXActions) => commands.syncExecuteCommand(SetDrawingApplyMutation.id, { ...target, op, objects: [target], type: 2 })
  return { univer, api, injector, commands, history, services, workbook, state, apply, report, drawing, policy, revokeEdit: () => {
    editing = false
  } }
}

afterEach(() => {
  for (const dispose of cleanup.splice(0))
    dispose()
})

it('固定 SDK 可从真实插表 mutation 读出非字符串名称，宿主名称出口必须另作类型核对', () => {
  const h = setup()
  expect(h.commands.syncExecuteCommand(InsertSheetMutation.id, { unitId: BOOK, index: 2, sheet: { ...h.workbook.getActiveSheet().getSnapshot(), id: 'odd-name', name: null } })).toBe(true)
  expect(h.workbook.getSheetBySheetId('odd-name')?.getName()).toBeNull()
})

describe('旧坏图清理：确认范围与历史屏障', () => {
  function history(h: ReturnType<typeof setup>) {
    h.history.pushUndoRedo({ unitID: BOOK, undoMutations: [], redoMutations: [] })
    h.history.pushUndoRedo({ unitID: 'another-book', undoMutations: [], redoMutations: [] })
  }

  it('准备和取消不改模型，不清除撤销记录', () => {
    const h = setup('blob:old')
    history(h)
    const before = h.state()
    const removal = h.policy.prepareLegacyRemoval(SHEET, ['image'])
    expect(removal).toBeDefined()
    expect(h.state()).toEqual(before)
    expect(removal?.confirm(false)).toBe('cancelled')
    expect(h.state()).toEqual(before)
    expect(removal?.confirm(true)).toBe('rejected')
  })

  it('只删明确确认的两张坏图，保留正常兄弟；成功仅清本书历史且通知两个服务', () => {
    const h = setup('blob:old')
    history(h)
    const notified = h.services.map(() => vi.fn())
    for (const [index, service] of h.services.entries()) {
      const images = { image: structuredClone(h.drawing), good: { ...h.drawing, drawingId: 'good', source: SOURCE, base64Cache: SOURCE }, bad2: { ...h.drawing, drawingId: 'bad2' } }
      service.setDrawingData(BOOK, SHEET, images)
      service.setDrawingOrder(BOOK, SHEET, ['image', 'good', 'bad2'])
      const observer = service.remove$.subscribe(notified[index])
      cleanup.push(() => observer.unsubscribe())
    }
    const removal = h.policy.prepareLegacyRemoval(SHEET, ['image', 'bad2'])
    expect(removal?.confirm(true)).toBe('removed')
    for (const service of h.services) {
      expect(service.getDrawingOrder(BOOK, SHEET)).toEqual(['good'])
      expect(Object.keys(service.getDrawingData(BOOK, SHEET))).toEqual(['good'])
    }
    expect(h.history.getUndoRedoStatus(BOOK)).toEqual({ undos: 0, redos: 0 })
    expect(h.history.getUndoRedoStatus('another-book')).toEqual({ undos: 1, redos: 0 })
    for (const callback of notified)
      expect(callback).toHaveBeenCalledTimes(1)
    expect(removal?.confirm(true)).toBe('rejected')
  })

  it.each(['changed', 'revoked', 'disposed'] as const)('确认前 %s 使旧票据失效，不清史', (reason) => {
    const h = setup('blob:old')
    history(h)
    const removal = h.policy.prepareLegacyRemoval(SHEET, ['image'])
    if (reason === 'changed') {
      const images = { image: { ...h.drawing, source: SOURCE, base64Cache: SOURCE } }
      for (const service of h.services)
        service.setDrawingData(BOOK, SHEET, images)
    }
    else if (reason === 'revoked') {
      h.revokeEdit()
    }
    else {
      h.policy.dispose()
    }
    const before = h.state()
    expect(removal?.confirm(true)).toBe('rejected')
    expect(h.state()).toEqual(before)
  })

  it('有效图片、分组中的图片和跨表/不存在 ID 不扩大清理范围', () => {
    const h = setup('blob:old')
    history(h)
    const images = { image: { ...h.drawing, groupId: 'group' }, good: { ...h.drawing, drawingId: 'good', source: SOURCE, base64Cache: SOURCE } }
    for (const service of h.services)
      service.setDrawingData(BOOK, SHEET, images)
    const before = h.state()
    expect(h.policy.prepareLegacyRemoval(SHEET, ['image'])).toBeUndefined()
    expect(h.policy.prepareLegacyRemoval(SHEET, ['good'])).toBeUndefined()
    expect(h.policy.prepareLegacyRemoval(SHEET, ['missing'])).toBeUndefined()
    expect(h.policy.prepareLegacyRemoval('other', ['image'])).toBeUndefined()
    expect(h.state()).toEqual(before)
  })

  it('后续守卫取消了真实 mutation 时，模型和历史仍完整', () => {
    const h = setup('blob:old')
    history(h)
    const removal = h.policy.prepareLegacyRemoval(SHEET, ['image'])
    const guard = h.api.addEvent(h.api.Event.BeforeCommandExecute, (event) => {
      if (event.id === SetDrawingApplyMutation.id)
        event.cancel = true
    })
    cleanup.push(() => guard.dispose())
    const before = h.state()
    expect(removal?.confirm(true)).toBe('rejected')
    expect(h.state()).toEqual(before)
  })

  it('两个服务目标不同，不能建立清理票据或借字段伪造许可', () => {
    const h = setup('blob:old')
    history(h)
    h.services[0]?.setDrawingData(BOOK, SHEET, {})
    const before = h.state()
    expect(h.policy.prepareLegacyRemoval(SHEET, ['image'])).toBeUndefined()
    const op = JSON1.removeOp(path, true)
    expect(h.commands.syncExecuteCommand(SetDrawingApplyMutation.id, { ...target, op, type: 1, objects: [target], allowLegacyRemoval: true })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('准备时复制 ID 和顺序，原数组被改动也不能扩张确认范围', () => {
    const h = setup('blob:old')
    const ids = ['image']
    const removal = h.policy.prepareLegacyRemoval(SHEET, ids)
    ids[0] = 'another'
    expect(removal?.confirm(true)).toBe('removed')
    expect(h.services[0]?.getDrawingByParam(target)).toBeUndefined()
  })

  it('同一对象在确认前被原地换源，旧确认不能删除新图', () => {
    const h = setup('blob:old')
    history(h)
    const removal = h.policy.prepareLegacyRemoval(SHEET, ['image'])
    for (const service of h.services) {
      const drawing = service.getDrawingByParam(target)
      if (drawing)
        Object.assign(drawing, { source: 'blob:replaced', base64Cache: 'blob:replaced' })
    }
    const before = h.state()
    expect(removal?.confirm(true)).toBe('rejected')
    expect(h.state()).toEqual(before)
  })

  it('真实只读防火墙仍取消清理与直接写入；成功清理后普通编辑仍可撤销', async () => {
    const h = setup('blob:old')
    history(h)
    const removal = h.policy.prepareLegacyRemoval(SHEET, ['image'])
    const readOnly = installReadOnlyGuard(h.univer, h.api, { unitId: BOOK, excludedMutationIds: [] })
    const before = h.state()
    expect(removal?.confirm(true)).toBe('rejected')
    expect(h.apply(JSON1.editOp([...path, 'transform', 'left'], 'number', 5))).toBe(false)
    expect(h.state()).toEqual(before)
    readOnly.dispose()
    expect(h.policy.prepareLegacyRemoval(SHEET, ['image'])?.confirm(true)).toBe('removed')
    expect(await h.commands.executeCommand(SetRangeValuesCommand.id, { unitId: BOOK, subUnitId: SHEET, range: { startRow: 3, endRow: 3, startColumn: 3, endColumn: 3 }, value: { v: 'after' } })).toBe(true)
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.workbook.getSheetBySheetId(SHEET)?.getCellRaw(3, 3)?.v).toBeUndefined()
  })

  it('mutation 已提交后的监听异常仍建立历史屏障，不能误报未清理', () => {
    const h = setup('blob:old')
    history(h)
    const listener = h.commands.onCommandExecuted((command) => {
      if (command.id === SetDrawingApplyMutation.id)
        throw new Error('本地后置监听故障')
    })
    cleanup.push(() => listener.dispose())
    expect(h.policy.prepareLegacyRemoval(SHEET, ['image'])?.confirm(true)).toBe('removed')
    for (const service of h.services)
      expect(service.getDrawingByParam(target)).toBeUndefined()
    expect(h.history.getUndoRedoStatus(BOOK)).toEqual({ undos: 0, redos: 0 })
    expect(h.report).toHaveBeenCalledTimes(1)
  })
})

describe('真实图片命令：归一发生在生成历史之前', () => {
  it('合法同源绝对地址归一，undo/redo 精确恢复两个服务', async () => {
    const h = setup()
    const drawings = [Object.freeze({ ...target, source: `${location.origin}${OTHER}`, base64Cache: `${location.origin}${OTHER}` })]
    expect(await h.commands.executeCommand(SetSheetDrawingCommand.id, { drawings })).toBe(true)
    const check = (source: string) => {
      for (const service of h.services)
        expect(service.getDrawingByParam(target)).toMatchObject({ source, base64Cache: source })
    }
    check(OTHER)
    expect(drawings[0]?.source).toBe(`${location.origin}${OTHER}`)
    expect(h.history.getUndoRedoStatus(BOOK)).toEqual({ undos: 1, redos: 0 })
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    check(SOURCE)
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    check(OTHER)
    expect(h.report).not.toHaveBeenCalled()
  })

  it('整批更新中后一个非法，前一个及历史、版本均不变', async () => {
    const h = setup()
    const before = h.state()
    expect(await h.commands.executeCommand(SetSheetDrawingCommand.id, { drawings: [
      { ...target, source: `${location.origin}${OTHER}` },
      { ...target, source: 'https://private-input.example/secret.png' },
    ] })).toBe(false)
    expect(h.state()).toEqual(before)
    expect(h.report).toHaveBeenCalledTimes(1)
    expect(String(h.report.mock.calls[0]?.[0])).not.toContain('private-input')
  })

  it.each([SetSheetDrawingCommand.id, RemoveSheetDrawingCommand.id])('普通 %s 不能生成恢复非法旧地址的 undo', async (id) => {
    const h = setup('blob:old-invalid')
    const before = h.state()
    expect(await h.commands.executeCommand(id, { drawings: [{ ...target, source: SOURCE, base64Cache: SOURCE }] })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('非法旧地址未被改动时，独立的位置更新仍能撤销', async () => {
    const h = setup('blob:old-invalid')
    expect(await h.commands.executeCommand(SetSheetDrawingCommand.id, { drawings: [{ ...target, transform: { left: 20, top: 0, width: 100, height: 100 } }] })).toBe(true)
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    for (const service of h.services)
      expect(service.getDrawingByParam(target)).toMatchObject({ source: 'blob:old-invalid', transform: { left: 0 } })
  })
})

describe('真实 JSON1 候选状态：两个服务同时预检且没有原地副作用', () => {
  it.each([{ type: 9, objects: [target] }, { type: 2 }, { type: 2, objects: [null] }])('通知参数 %j 不能在写完两个服务后才发现非法', (notification) => {
    const h = setup()
    const before = h.state()
    expect(h.commands.syncExecuteCommand(SetDrawingApplyMutation.id, { ...target, op: JSON1.editOp([...path, 'transform', 'left'], 'number', 5), ...notification })).toBe(false)
    expect(h.state()).toEqual(before)
  })
  it.each(['https://outside.example/image.png', `${location.origin}${OTHER}`, 'data:image/png;base64,AAAA'])('直接 mutation 的非规范来源 %s 被拒绝', (source) => {
    const h = setup()
    const before = h.state()
    expect(h.apply(JSON1.replaceOp([...path, 'source'], SOURCE, source))).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('先明确证明 TextX apply 会改旧对象，再验证策略在 apply 之前拒绝', () => {
    const body = { dataStream: 'a\r\n' }
    const op: JSONXActions = ['body', { et: 'text-x', e: [{ t: 'i', len: 1, body: { dataStream: 'b' } }] }]
    JSON1.type.apply({ body }, op)
    expect(body.dataStream).toBe('ba\r\n')
    const h = setup()
    const before = h.state()
    const composed = JSON1.type.compose(
      [...path, 'body', { et: 'text-x', e: [{ t: 'i', len: 1, body: { dataStream: 'b' } }] }],
      JSON1.replaceOp([...path, 'source'], SOURCE, 'blob:bad'),
    )
    expect(h.apply(composed)).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('纯字符串/数值子类型不误拦，原数据对象不被预演改写', () => {
    const h = setup()
    const originals = h.services.map(service => service.drawingManagerData)
    const op = JSON1.type.compose(JSON1.editOp([...path, 'altText'], 'text-unicode', [1, 'b']), JSON1.editOp([...path, 'transform', 'left'], 'number', 5))
    expect(h.apply(op)).toBe(true)
    for (const [index, service] of h.services.entries()) {
      expect(service.getDrawingByParam(target)).toMatchObject({ altText: 'ab', transform: { left: 5 } })
      expect(originals[index]?.[BOOK]?.[SHEET]?.data.image).toMatchObject({ altText: 'a', transform: { left: 0 } })
    }
  })

  it('第二个服务无法应用时，第一个也不能先写入', () => {
    const h = setup()
    h.services[1]?.setDrawingData(BOOK, SHEET, {})
    const before = h.state()
    expect(h.apply(JSON1.replaceOp([...path, 'source'], SOURCE, OTHER))).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it.each([UndoCommand.id, RedoCommand.id])('%s 在第一条 pre-mutation 前预检整条记录', async (id) => {
    const h = setup()
    let calls = 0
    h.commands.registerCommand({ id: 'test.mutation.sentinel', type: CommandType.MUTATION, handler: () => {
      calls++
      return true
    } })
    const record = { unitID: BOOK, undoMutations: [
      { id: 'test.mutation.sentinel', params: {} },
      { id: SetDrawingApplyMutation.id, params: { ...target, objects: [target], type: 2, op: JSON1.replaceOp([...path, 'source'], SOURCE, 'blob:bad') } },
    ], redoMutations: [] }
    h.history.pushUndoRedo(id === UndoCommand.id ? record : { ...record, redoMutations: record.undoMutations })
    if (id === RedoCommand.id)
      h.history.popUndoToRedo()
    const before = h.state()
    expect(await h.commands.executeCommand(id)).toBe(false)
    expect(calls).toBe(0)
    expect(h.state()).toEqual(before)
  })
})

describe('单元格片段经过实际命令与 mutation', () => {
  it('真实 SDK 富文本的无限页面尺寸是运行期布局值，正常写入与撤销重做不应被图片规则拒绝', async () => {
    const h = setup()
    const p = createDocumentModelWithStyle('axyz', {}).getSnapshot()
    expect(p.documentStyle.pageSize).toEqual({ width: Infinity, height: Infinity })
    const params = { unitId: BOOK, subUnitId: SHEET, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }, value: { p } }
    expect(await h.commands.executeCommand(SetRangeValuesCommand.id, params)).toBe(true)
    const cell = () => h.workbook.getSheetBySheetId(SHEET)?.getCellRaw(0, 0)
    expect(cell()?.p?.body?.dataStream).toBe('axyz\r\n')
    expect(cell()?.p?.documentStyle.pageSize).toEqual({ width: Infinity, height: Infinity })
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(cell()?.p).toBeUndefined()
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    expect(cell()?.p?.body?.dataStream).toBe('axyz\r\n')
    expect(h.report).not.toHaveBeenCalled()
  })

  it('运行期富文本尺寸不使其中的非法图片来源被放行', async () => {
    const h = setup()
    const p = createDocumentModelWithStyle('axyz', {}).getSnapshot()
    const before = h.state()
    expect(await h.commands.executeCommand(SetRangeValuesCommand.id, {
      unitId: BOOK,
      subUnitId: SHEET,
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
      value: { p: { ...p, drawings: { image: { ...h.drawing, source: 'blob:bad' } } } },
    })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it.each([SetRangeValuesCommand.id, SetRangeValuesMutation.id])('%s 不得把非法旧 p 带进逆操作', async (id) => {
    const h = setup()
    const oldImage = { ...h.drawing, source: 'blob:old' }
    h.workbook.getSheetBySheetId(SHEET)?.getCellMatrix().setValue(0, 0, { p: { id: 'old-rich', documentStyle: {}, body: { dataStream: 'old\r\n' }, drawings: { image: oldImage } } })
    const before = h.state()
    const params = id === SetRangeValuesCommand.id
      ? { unitId: BOOK, subUnitId: SHEET, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }, value: { v: 'new', p: null } }
      : { unitId: BOOK, subUnitId: SHEET, cellValue: { 0: { 0: { v: 'new', p: null } } } }
    expect(await h.commands.executeCommand(id, params)).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('命名样式内的非法图片不得借 s 字符串写入', () => {
    const h = setup()
    // SDK 样式数据可以含扩展填充；由只读载入的实际样式表供命令解析。
    const style = { bg: { rgb: '#FFFFFF', source: 'blob:style' } }
    const styleId = h.workbook.getStyles().setValue(style)
    const before = h.state()
    expect(h.commands.syncExecuteCommand(SetRangeValuesMutation.id, { unitId: BOOK, subUnitId: SHEET, cellValue: { 0: { 0: { s: styleId } } } })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('高层单格 p 在历史之前归一，撤销/重做后的 source 一致', async () => {
    const h = setup()
    const p = { id: 'rich-cell', body: { dataStream: 'text\r\n' }, drawings: { image: { ...h.drawing, source: `${location.origin}${OTHER}`, base64Cache: `${location.origin}${OTHER}` } } }
    expect(await h.commands.executeCommand(SetRangeValuesCommand.id, { unitId: BOOK, subUnitId: SHEET, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }, value: { p } })).toBe(true)
    const cell = () => h.workbook.getSheetBySheetId(SHEET)?.getCellRaw(0, 0)
    expect(cell()?.p?.drawings?.image).toMatchObject({ source: OTHER, base64Cache: OTHER })
    expect(p.drawings.image.source).toBe(`${location.origin}${OTHER}`)
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(cell()?.p).toBeUndefined()
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    expect(cell()?.p?.drawings?.image).toMatchObject({ source: OTHER, base64Cache: OTHER })
  })

  it('非法嵌套图片拒绝整个底层批次，普通值不进入图片解析', () => {
    const h = setup()
    const before = h.state()
    expect(h.commands.syncExecuteCommand(SetRangeValuesMutation.id, { unitId: BOOK, subUnitId: SHEET, cellValue: { 0: { 0: { v: '普通' }, 1: { p: { drawings: { image: { source: 'blob:bad' } } } } } } })).toBe(false)
    expect(h.state()).toEqual(before)
    expect(h.commands.syncExecuteCommand(SetRangeValuesMutation.id, { unitId: BOOK, subUnitId: SHEET, cellValue: { 0: { 0: { v: 'https://example.com/ordinary-text' } } } })).toBe(true)
    expect(h.workbook.getSheetBySheetId(SHEET)?.getCellRaw(0, 0)?.v).toBe('https://example.com/ordinary-text')
  })
})

describe('工作表结构变化必须在 handler 前拒绝坏逆操作', () => {
  it.each([RemoveRowByRangeCommand.id, RemoveColByRangeCommand.id])('%s 的指定表与 SDK 图片后处理的当前表不一致时，在两边写入前拒绝', async (id) => {
    const h = setup('blob:old')
    const before = h.state()
    expect(await h.commands.executeCommand(id, { unitId: BOOK, subUnitId: 'other', range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 } })).toBe(false)
    expect(h.state()).toEqual(before)
  })
  it('两服务均缺 order 项时，在删行之前拒绝', async () => {
    const h = setup()
    for (const service of h.services)
      service.setDrawingOrder(BOOK, SHEET, [])
    const before = h.state()
    expect(await h.commands.executeCommand(RemoveRowByRangeCommand.id, { unitId: BOOK, subUnitId: SHEET, range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 9 } })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it.each([RemoveSheetCommand.id, CopySheetCommand.id])('%s 接受实际渲染函数单侧补齐的 transform 默认字段', async (id) => {
    const h = setup()
    const skeleton = h.injector.get(SheetSkeletonService).getSkeletonParam(BOOK, SHEET)
    if (!skeleton)
      throw new Error('缺少真实工作表布局')
    skeleton.skeleton.calculate()
    const transform = drawingPositionToTransform(h.drawing.sheetTransform, skeleton)
    expect(transform).toHaveProperty('flipX', false)
    const image = h.services[0]?.getDrawingByParam(target)
    if (image)
      image.transform = transform
    expect(await h.commands.executeCommand(id, { unitId: BOOK, subUnitId: SHEET })).toBe(true)
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    expect(h.report).not.toHaveBeenCalled()
  })

  it('多字段归一遇到不可写参数时，参数和插表状态均不部分改变', async () => {
    const h = setup()
    const params = { unitId: BOOK, sheet: { id: 'new', cellData: { 0: { 0: { p: { drawings: { image: { source: `${location.origin}${SOURCE}` } } } } } } }, styles: { image: { fill: { source: `${location.origin}${SOURCE}` } } } }
    Object.defineProperty(params, 'styles', { writable: false })
    const original = structuredClone(params)
    const before = h.state()
    expect(await h.commands.executeCommand(InsertSheetCommand.id, params)).toBe(false)
    expect(params).toEqual(original)
    expect(h.state()).toEqual(before)
  })
  it.each([DeleteRangeMoveLeftCommand.id, DeleteRangeMoveUpCommand.id, InsertRangeMoveDownCommand.id, InsertRangeMoveRightCommand.id])('%s 的正常无参选区操作可以撤销与重做', async (id) => {
    const h = setup()
    const range = { startRow: 3, endRow: 3, startColumn: 3, endColumn: 3 }
    h.injector.get(SheetsSelectionsService).setSelections([{ range, primary: null, style: null }])
    h.workbook.getSheetBySheetId(SHEET)?.getCellMatrix().setValue(3, 3, { v: 'source' })
    expect(await h.commands.executeCommand(id)).toBe(true)
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.workbook.getSheetBySheetId(SHEET)?.getCellRaw(3, 3)?.v).toBe('source')
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    expect(h.report).not.toHaveBeenCalled()
  })
  it.each([DeleteRangeMoveLeftCommand.id, DeleteRangeMoveUpCommand.id, InsertRangeMoveDownCommand.id, InsertRangeMoveRightCommand.id])('%s 依照 SDK 的当前表解析，不相信忽略的名义目标', async (id) => {
    const h = setup('blob:old')
    const before = h.state()
    expect(await h.commands.executeCommand(id, { unitId: BOOK, subUnitId: 'other', range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 } })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('两份绘图服务缺少相同路径时，不能先删除工作表再失败', async () => {
    const h = setup()
    h.services[0]?.setDrawingData(BOOK, SHEET, {})
    const before = h.state()
    expect(await h.commands.executeCommand(RemoveSheetCommand.id, { unitId: BOOK, subUnitId: SHEET })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it.each([RemoveRowByRangeCommand.id, RemoveColByRangeCommand.id])('%s 删除锚定区不能把坏图带进撤销栈', async (id) => {
    const h = setup('blob:old')
    const before = h.state()
    expect(await h.commands.executeCommand(id, { unitId: BOOK, subUnitId: SHEET, range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 } })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('渲染服务合法的像素 transform 差异不妨碍删除及撤销', async () => {
    const h = setup()
    h.services[0]?.setDrawingData(BOOK, SHEET, { image: { ...h.drawing, transform: { ...h.drawing.transform, left: 25 } } })
    expect(await h.commands.executeCommand(RemoveSheetCommand.id, { unitId: BOOK, subUnitId: SHEET })).toBe(true)
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.workbook.getSheetBySheetId(SHEET)).not.toBeNull()
    expect(h.report).not.toHaveBeenCalled()
  })

  it('新表的同源图片先归一，插表与 undo/redo 全链路保留来源', async () => {
    const h = setup()
    const p = { id: 'new-rich', body: { dataStream: 'new\r\n' }, drawings: { image: { ...h.drawing, source: `${location.origin}${SOURCE}`, base64Cache: `${location.origin}${SOURCE}` } } }
    expect(await h.commands.executeCommand(InsertSheetCommand.id, { unitId: BOOK, index: 1, sheet: { id: 'new', name: 'New', cellData: { 0: { 0: { p } } } } })).toBe(true)
    expect(h.workbook.getSheetBySheetId('new')?.getCellRaw(0, 0)?.p?.drawings?.image).toMatchObject({ source: SOURCE, base64Cache: SOURCE })
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.workbook.getSheetBySheetId('new')).toBeUndefined()
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    expect(h.workbook.getSheetBySheetId('new')?.getCellRaw(0, 0)?.p?.drawings?.image).toMatchObject({ source: SOURCE, base64Cache: SOURCE })
    expect(p.drawings.image.source).toBe(`${location.origin}${SOURCE}`)
  })

  it('合法跨表移动的两份单元格与历史均可往返', async () => {
    const h = setup()
    h.workbook.getSheetBySheetId(SHEET)?.getCellMatrix().setValue(3, 3, { v: 'source' })
    h.workbook.getSheetBySheetId('other')?.getCellMatrix().setValue(3, 3, { v: 'target' })
    const before = h.state().cells
    expect(await h.commands.executeCommand(MoveRangeCommand.id, {
      fromUnitId: BOOK,
      toUnitId: BOOK,
      fromSubUnitId: SHEET,
      toSubUnitId: 'other',
      fromRange: { startRow: 3, endRow: 3, startColumn: 3, endColumn: 3 },
      toRange: { startRow: 3, endRow: 3, startColumn: 3, endColumn: 3 },
    })).toBe(true)
    const moved = h.state().cells
    expect(h.workbook.getSheetBySheetId('other')?.getCellRaw(3, 3)?.v).toBe('source')
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.state().cells).toEqual(before)
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    expect(h.state().cells).toEqual(moved)
  })
  it.each([RemoveSheetCommand.id, CopySheetCommand.id])('%s 遇到旧非法图片不能先删/建表再报失败', async (id) => {
    const h = setup('blob:old')
    const before = h.state()
    expect(await h.commands.executeCommand(id, { unitId: BOOK, subUnitId: SHEET })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('正常删除图片工作表仍可完整撤销和重做', async () => {
    const h = setup()
    expect(await h.commands.executeCommand(RemoveSheetCommand.id, { unitId: BOOK, subUnitId: SHEET })).toBe(true)
    expect(h.workbook.getSheetBySheetId(SHEET)).toBeUndefined()
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.workbook.getSheetBySheetId(SHEET)?.getName()).toBe('Sheet')
    for (const service of h.services)
      expect(service.getDrawingByParam(target)).toMatchObject({ source: SOURCE, base64Cache: SOURCE })
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    expect(h.workbook.getSheetBySheetId(SHEET)).toBeUndefined()
  })

  it.each([InsertSheetCommand.id, InsertSheetMutation.id])('%s 的坏片段必须在插表/加样式之前拒绝', async (id) => {
    const h = setup()
    const before = h.state()
    expect(await h.commands.executeCommand(id, { unitId: BOOK, index: 1, styles: { bad: { fill: { source: 'blob:bad-style' } } }, sheet: { id: 'new-sheet', name: 'New', cellData: { 0: { 0: { p: { drawings: { image: { source: 'blob:bad' } } } } } } } })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('插行携带的坏 cellValue 在行数改变之前拒绝', async () => {
    const h = setup()
    const before = h.state()
    expect(await h.commands.executeCommand(InsertRowByRangeCommand.id, {
      unitId: BOOK,
      subUnitId: SHEET,
      direction: Direction.UP,
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 9 },
      cellValue: { 0: { 0: { p: { drawings: { image: { source: 'blob:bad' } } } } } },
    })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('MoveRange mutation 的两份矩阵整批验证，不能先清空源区', () => {
    const h = setup()
    h.workbook.getSheetBySheetId(SHEET)?.getCellMatrix().setValue(0, 0, { v: 'keep' })
    const before = h.state()
    expect(h.commands.syncExecuteCommand(MoveRangeMutation.id, {
      unitId: BOOK,
      from: { subUnitId: SHEET, value: { 0: { 0: null } } },
      to: { subUnitId: 'other', value: { 0: { 0: { p: { drawings: { image: { source: 'blob:bad' } } } } } } },
    })).toBe(false)
    expect(h.state()).toEqual(before)
  })

  it('跨表 MoveRange 不把目标区的旧坏富文本放进 undo', async () => {
    const h = setup()
    const badImage = { ...h.drawing, source: 'blob:old-target' }
    h.workbook.getSheetBySheetId(SHEET)?.getCellMatrix().setValue(0, 0, { v: 'source' })
    h.workbook.getSheetBySheetId('other')?.getCellMatrix().setValue(0, 0, { p: { id: 'old-target', documentStyle: {}, body: { dataStream: 'old\r\n' }, drawings: { image: badImage } } })
    const before = h.state()
    expect(await h.commands.executeCommand(MoveRangeCommand.id, {
      fromUnitId: BOOK,
      toUnitId: BOOK,
      fromSubUnitId: SHEET,
      toSubUnitId: 'other',
      fromRange: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
      toRange: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    })).toBe(false)
    expect(h.state()).toEqual(before)
  })
})
