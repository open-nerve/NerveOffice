import type { Workbook } from '@univerjs/core'
import type { ISheetImage } from '@univerjs/sheets-drawing'
import { DrawingTypeEnum, ICommandService, ImageSourceType, IUniverInstanceService, LocaleType, RedoCommand, UndoCommand, Univer, UniverInstanceType } from '@univerjs/core'
import { IDrawingManagerService, UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { SetRowHeightCommand, SetWorksheetRowAutoHeightMutation, SheetSkeletonService, UniverSheetsPlugin } from '@univerjs/sheets'
import { drawingPositionToTransform, ISheetDrawingService, SheetDrawingAnchorType, UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing'
import { afterEach, describe, expect, it } from 'vitest'
import { editorIdentityOverride } from '../identity/editor-authz-io.service.ts'
import { SHEET_ZH_CN } from '../profile/locale.ts'
import { injectorOf } from './injector.ts'

const cleanup: (() => void)[] = []
const originalAnchor = { from: { row: 2, column: 2, rowOffset: 0, columnOffset: 0 }, to: { row: 6, column: 4, rowOffset: 0, columnOffset: 20 } }
const resizedAnchor = { from: { row: 2, column: 2, rowOffset: 0, columnOffset: 0 }, to: { row: 4, column: 4, rowOffset: 0, columnOffset: 20 } }

function setup(anchorType = SheetDrawingAnchorType.Position) {
  const univer = new Univer({ locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: SHEET_ZH_CN }, override: editorIdentityOverride('edit') })
  univer.registerPlugin(UniverRenderEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverDrawingPlugin)
  univer.registerPlugin(UniverSheetsDrawingPlugin)
  const workbook = univer.createUnit<unknown, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id: 'anchor-book',
    sheetOrder: ['sheet'],
    sheets: { sheet: { id: 'sheet', name: 'Sheet', rowCount: 20, columnCount: 10, defaultRowHeight: 20, defaultColumnWidth: 50 } },
  })
  const injector = injectorOf(univer)
  injector.get(IUniverInstanceService).focusUnit(workbook.getUnitId())
  const skeletons = injector.get(SheetSkeletonService)
  const skeleton = skeletons.getSkeletonParam('anchor-book', 'sheet')
  if (!skeleton)
    throw new Error('缺少真实工作表布局')
  skeleton.skeleton.calculate()
  const transform = drawingPositionToTransform(originalAnchor, skeleton)
  expect(transform).toMatchObject({ width: 120, height: 80 })
  const drawing: ISheetImage = {
    unitId: workbook.getUnitId(),
    subUnitId: 'sheet',
    drawingId: 'image',
    drawingType: DrawingTypeEnum.DRAWING_IMAGE,
    imageSourceType: ImageSourceType.URL,
    source: '/api/assets/11111111-1111-4111-8111-111111111111.png',
    anchorType,
    transform,
    sheetTransform: structuredClone(originalAnchor),
    axisAlignSheetTransform: structuredClone(originalAnchor),
  }
  const sheets = injector.get(ISheetDrawingService)
  const drawings = injector.get(IDrawingManagerService)
  sheets.setDrawingData('anchor-book', 'sheet', { image: structuredClone(drawing) })
  drawings.setDrawingData('anchor-book', 'sheet', { image: structuredClone(drawing) })
  const commands = injector.get(ICommandService)
  const executed: string[] = []
  const subscription = commands.onCommandExecuted(command => executed.push(command.id))
  cleanup.push(() => {
    subscription.dispose()
    univer.dispose()
  })
  return { univer, injector, sheets, drawings, drawing, commands, executed }
}

afterEach(() => {
  for (const finish of cleanup.splice(0))
    finish()
})

describe('UR-009：默认 Position 自动行高后的尺寸与锚点一起保留', () => {
  it('refreshTransform 同步提供的两份锚点，未提供字段时保留既有锚点', () => {
    const h = setup()
    const next = { ...h.drawing, sheetTransform: resizedAnchor, axisAlignSheetTransform: resizedAnchor }
    h.sheets.refreshTransform([next])
    h.drawings.refreshTransform([next])
    for (const service of [h.sheets, h.drawings]) {
      expect(service.getDrawingByParam(h.drawing)).toMatchObject({ sheetTransform: resizedAnchor, axisAlignSheetTransform: resizedAnchor })
    }
    h.drawings.refreshTransform([{ unitId: 'anchor-book', subUnitId: 'sheet', drawingId: 'image', drawingType: DrawingTypeEnum.DRAWING_IMAGE, transform: { width: 120, height: 80 } }])
    expect(h.drawings.getDrawingByParam(h.drawing)).toMatchObject({ sheetTransform: resizedAnchor, axisAlignSheetTransform: resizedAnchor })
  })

  it.each([
    [SheetDrawingAnchorType.Position, 80, 4],
    [SheetDrawingAnchorType.Both, 120, 6],
    [SheetDrawingAnchorType.None, 80, 6],
  ] as const)('真实自动行高 mutation：锚定 %s 后高 %s，终点行 %s', async (anchorType, height, endRow) => {
    const h = setup(anchorType)
    expect(h.commands.syncExecuteCommand(SetWorksheetRowAutoHeightMutation.id, {
      unitId: 'anchor-book',
      subUnitId: 'sheet',
      rowsAutoHeightInfo: [{ row: 3, autoHeight: 60 }],
    }, { onlyLocal: true })).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const service of [h.sheets, h.drawings]) {
      expect(service.getDrawingByParam(h.drawing)).toMatchObject({
        transform: { width: 120, height },
        sheetTransform: { from: originalAnchor.from, to: { row: endRow, rowOffset: 0 } },
        axisAlignSheetTransform: { from: originalAnchor.from, to: { row: endRow, rowOffset: 0 } },
      })
      if (anchorType === SheetDrawingAnchorType.Position) {
        expect(service.getDrawingByParam(h.drawing)).toEqual(expect.objectContaining({
          sheetTransform: resizedAnchor,
          axisAlignSheetTransform: resizedAnchor,
        }))
      }
    }
    expect(h.executed).not.toContain('sheet.mutation.set-drawing-apply')
  })

  it('显式行高仍保留尺寸，撤销和重做恢复各自的两份锚点', async () => {
    const h = setup()
    const check = (row: number) => {
      for (const service of [h.sheets, h.drawings]) {
        expect(service.getDrawingByParam(h.drawing)).toMatchObject({
          transform: { width: 120, height: 80 },
          sheetTransform: { to: { row, rowOffset: 0 } },
          axisAlignSheetTransform: { to: { row, rowOffset: 0 } },
        })
      }
    }
    expect(await h.commands.executeCommand(SetRowHeightCommand.id, { unitId: 'anchor-book', subUnitId: 'sheet', ranges: [{ startRow: 3, endRow: 3, startColumn: 0, endColumn: 9 }], value: 60 })).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    check(4)
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    check(6)
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    check(4)
  })
})
