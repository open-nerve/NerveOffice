import type { Workbook } from '@univerjs/core'
import type { ISheetImage } from '@univerjs/sheets-drawing'
import type { CapturedImageTarget } from './image-input.ts'
import { DrawingTypeEnum, ICommandService, ImageSourceType, IUniverInstanceService, LocaleType, RedoCommand, UndoCommand, Univer, UniverInstanceType } from '@univerjs/core'
import { IDrawingManagerService, UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { convertPositionCellToSheetOverGrid, SetRowHeightCommand, SetWorksheetRowAutoHeightMutation, SheetSkeletonService, UniverSheetsPlugin } from '@univerjs/sheets'
import { drawingPositionToTransform, ISheetDrawingService, SheetDrawingAnchorType, transformToDrawingPosition, UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing'
import { afterEach, describe, expect, it } from 'vitest'
import { editorIdentityOverride } from '../identity/editor-authz-io.service.ts'
import { SHEET_ZH_CN } from '../profile/locale.ts'
import { prepareImageInsertion } from './image-input-insert.ts'
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

// 插入（convertPositionCellToSheetOverGrid）与移动、拖拽缩放、翻转、图片复制粘贴（transformToDrawingPosition）
// 传入的都是工作表绝对坐标；视口滚动或缩放只改变显示，不能进入存下的锚点（M5-P8 S6 的 N4 实测）。
describe('DEF-081：滚动或缩放之后，浮图锚点仍按工作表绝对坐标换算', () => {
  const views = [
    ['纵向滚动', { scrollX: 0, scrollY: 100, scale: 1 }],
    ['横向滚动', { scrollX: 130, scrollY: 0, scale: 1 }],
    ['放大到 200%', { scrollX: 0, scrollY: 0, scale: 2 }],
    ['滚动并缩小到 50%', { scrollX: 75, scrollY: 45, scale: 0.5 }],
  ] as const

  function skeletonOf(univer: Univer) {
    const param = injectorOf(univer).get(SheetSkeletonService).getSkeletonParam('anchor-book', 'sheet')
    if (!param)
      throw new Error('缺少真实工作表布局')
    return param.skeleton
  }

  it.each(views)('%s：插入与移动换算出的锚点与原视口相同', (_name, view) => {
    const h = setup()
    const skeleton = skeletonOf(h.univer)
    const transform = h.drawing.transform
    if (!transform)
      throw new Error('缺少浮图位置')
    const inserted = convertPositionCellToSheetOverGrid('anchor-book', 'sheet', originalAnchor.from, 120, 80, skeleton)
    const moved = transformToDrawingPosition(transform, skeleton)
    expect(inserted.sheetTransform).toEqual(originalAnchor)
    expect(moved).toMatchObject(originalAnchor)
    skeleton.setScroll(view.scrollX, view.scrollY)
    skeleton.setScale(view.scale)
    expect(convertPositionCellToSheetOverGrid('anchor-book', 'sheet', originalAnchor.from, 120, 80, skeleton)).toEqual(inserted)
    expect(transformToDrawingPosition(transform, skeleton)).toEqual(moved)
  })

  it.each(views)('%s：产品插入路径存下的两份锚点与原视口相同', (_name, view) => {
    const h = setup()
    // 产品经 ensureSkeleton 取布局；必须与这里设置滚动的是同一个实例，否则用例会空过。
    expect(injectorOf(h.univer).get(SheetSkeletonService).ensureSkeleton('anchor-book', 'sheet')).toBe(skeletonOf(h.univer))
    const target = { unitId: 'anchor-book', subUnitId: 'sheet', row: 2, column: 2, isCurrent: () => true, subscribe: () => () => {} } satisfies CapturedImageTarget
    const image = { source: '/api/assets/22222222-2222-4222-8222-222222222222', width: 120, height: 80 }
    const anchors = () => {
      const prepared = prepareImageInsertion(h.univer, target, image, 'float', 'http://127.0.0.1')
      const [drawing] = (prepared?.params as { drawings: ISheetImage[] } | undefined)?.drawings ?? []
      return { transform: drawing?.transform, sheetTransform: drawing?.sheetTransform, axisAlignSheetTransform: drawing?.axisAlignSheetTransform }
    }
    const before = anchors()
    expect(before).toMatchObject({ transform: { width: 120, height: 80 }, sheetTransform: originalAnchor, axisAlignSheetTransform: originalAnchor })
    const skeleton = skeletonOf(h.univer)
    skeleton.setScroll(view.scrollX, view.scrollY)
    skeleton.setScale(view.scale)
    expect(anchors()).toEqual(before)
  })
})
