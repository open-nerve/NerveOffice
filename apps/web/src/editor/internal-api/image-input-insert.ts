import type { Univer } from '@univerjs/core'
import type { CapturedImageTarget, PreparedInputImage } from './image-input.ts'
import { ASSET_MAX_PIXELS, ASSET_MAX_SIDE, isPlatformAssetAddress } from '@nerve-office/contracts'
import { BooleanNumber, BuildTextUtils, CellValueType, createDocumentModelWithStyle, DrawingTypeEnum, ImageSourceType, PositionedObjectLayoutType, WrapTextType } from '@univerjs/core'
import { buildDocTransform, docDrawingPositionToTransform } from '@univerjs/docs'
import { DRAWING_IMAGE_HEIGHT_LIMIT, DRAWING_IMAGE_WIDTH_LIMIT } from '@univerjs/drawing'
import { convertPositionCellToSheetOverGrid, SetRangeValuesCommand, SheetSkeletonService } from '@univerjs/sheets'
import { InsertSheetDrawingCommand } from '@univerjs/sheets-drawing'
import { injectorOf } from './injector.ts'

/** 只构造这张受管图片的命令参数；尺寸来自已验证的上传响应，不发请求或读取源地址。 */
export function prepareImageInsertion(univer: Univer, target: CapturedImageTarget, image: PreparedInputImage, kind: 'float' | 'cell', origin: string): { id: string, params: object } | undefined {
  if (!isPlatformAssetAddress(image.source, origin) || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width < 1 || image.height < 1 || image.width > ASSET_MAX_SIDE || image.height > ASSET_MAX_SIDE || image.width * image.height > ASSET_MAX_PIXELS) {
    return undefined
  }
  const skeleton = injectorOf(univer).get(SheetSkeletonService).ensureSkeleton(target.unitId, target.subUnitId)
  if (!skeleton)
    return undefined
  const source = image.source.startsWith('/') ? image.source : image.source.slice(origin.length)
  const drawingId = crypto.randomUUID()
  if (kind === 'float') {
    const scale = Math.min(1, DRAWING_IMAGE_WIDTH_LIMIT / image.width, DRAWING_IMAGE_HEIGHT_LIMIT / image.height)
    const { transform, sheetTransform } = convertPositionCellToSheetOverGrid(target.unitId, target.subUnitId, {
      row: target.row,
      column: target.column,
      rowOffset: 0,
      columnOffset: 0,
    }, image.width * scale, image.height * scale, skeleton)
    return { id: InsertSheetDrawingCommand.id, params: {
      unitId: target.unitId,
      drawings: [{
        unitId: target.unitId,
        subUnitId: target.subUnitId,
        drawingId,
        drawingType: DrawingTypeEnum.DRAWING_IMAGE,
        imageSourceType: ImageSourceType.URL,
        source,
        // 渲染器在重开时会写回这五个缺省值；创建时固定，避免无编辑也产生新修订。
        transform: { angle: 0, skewX: 0, skewY: 0, flipX: false, flipY: false, ...transform },
        sheetTransform,
        axisAlignSheetTransform: sheetTransform,
      }],
    } }
  }
  const cell = skeleton.getCellWithCoordByIndex(target.row, target.column).mergeInfo
  // 与 SDK 单元格图相同的 2 px 留白；小格保持正尺寸，宽高等比例，不把任何一边放到格外。
  const scale = Math.min(Math.max(1, cell.endX - cell.startX - 2) / image.width, Math.max(1, cell.endY - cell.startY - 2) / image.height)
  const docTransform = buildDocTransform(image.width * scale, image.height * scale)
  const document = createDocumentModelWithStyle('', {})
  const drawing = {
    unitId: document.getUnitId(),
    subUnitId: document.getUnitId(),
    drawingId,
    drawingType: DrawingTypeEnum.DRAWING_IMAGE,
    imageSourceType: ImageSourceType.URL,
    source,
    transform: docDrawingPositionToTransform(docTransform),
    docTransform,
    behindDoc: BooleanNumber.FALSE,
    title: '',
    description: '',
    layoutType: PositionedObjectLayoutType.INLINE,
    wrapText: WrapTextType.BOTH_SIDES,
    distB: 0,
    distL: 0,
    distR: 0,
    distT: 0,
  }
  const actions = BuildTextUtils.drawing.add({
    documentDataModel: document,
    drawings: [drawing],
    selection: { collapsed: true, startOffset: 0, endOffset: 0 },
  })
  if (actions === false)
    return undefined
  document.apply(actions)
  return { id: SetRangeValuesCommand.id, params: {
    unitId: target.unitId,
    subUnitId: target.subUnitId,
    value: { [target.row]: { [target.column]: { p: document.getSnapshot(), t: CellValueType.STRING, v: null, f: null, si: null } } },
  } }
}
