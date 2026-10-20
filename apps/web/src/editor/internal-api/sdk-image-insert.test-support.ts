import type { IImageIoServiceParam, Workbook } from '@univerjs/core'
import type { Engine, IRenderContext } from '@univerjs/engine-render'
import type { ISheetSelectionRenderService } from '@univerjs/sheets-ui'
import { ICommandService, IContextService, ImageSourceType, ImageUploadStatusType, LocaleService, UniverInstanceType } from '@univerjs/core'
import { SheetInterceptorService, SheetSkeletonService, SheetsSelectionsService, UniverSheetsPlugin } from '@univerjs/sheets'
import { ISheetDrawingService, UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing'
import { SheetDrawingUpdateController } from '@univerjs/sheets-drawing-ui'
import { of } from 'rxjs'
import { vi } from 'vitest'
import { sdkImageHarness, SOURCE } from './sdk-image-render.test-support.ts'

export const UPLOADED: IImageIoServiceParam = {
  imageId: 'uploaded',
  imageSourceType: ImageSourceType.URL,
  source: SOURCE,
  base64Cache: SOURCE,
  status: ImageUploadStatusType.SUCCUSS,
}

/** 真实控制器、数据插件和工作簿；测量结束后由空选区/缺失布局终止，不在 jsdom 假装验收插入的画面。 */
export function sdkInsertHarness() {
  const h = sdkImageHarness()
  h.univer.registerPlugin(UniverSheetsPlugin)
  h.univer.registerPlugin(UniverSheetsDrawingPlugin)
  const workbook = h.univer.createUnit<unknown, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id: 'sizing-book',
    sheetOrder: ['one', 'two'],
    sheets: { one: { id: 'one', name: 'One', rowCount: 10, columnCount: 10 }, two: { id: 'two', name: 'Two', rowCount: 10, columnCount: 10 } },
  })
  const context: IRenderContext<Workbook> = {
    unitId: workbook.getUnitId(),
    unit: workbook,
    type: UniverInstanceType.UNIVER_SHEET,
    scene: h.scene,
    mainComponent: null,
    components: new Map(),
    isMainScene: true,
    activated$: of(true),
    activate: () => {},
    deactivate: () => {},
    // 此测试不启动画布；一旦越过约定的布局边界就明确失败，不能默默提供残缺的伪实现。
    engine: new Proxy({} as Engine, { get: () => { throw new Error('此测量回归不能访问画布') } }),
  }
  const selections = h.injector.get(SheetsSelectionsService)
  vi.spyOn(selections.getWorkbookSelections(workbook.getUnitId()), 'getCurrentLastSelection').mockReturnValue(undefined)
  const skeletons = h.injector.get(SheetSkeletonService)
  vi.spyOn(skeletons, 'getSkeletonParam').mockReturnValue(undefined)
  const selectionRender = new Proxy({} as ISheetSelectionRenderService, { get: () => {
    throw new Error('此测量回归不能访问选区布局')
  } })
  const saveImage = vi.fn(async (): Promise<IImageIoServiceParam | null> => UPLOADED)
  h.images.saveImage = saveImage
  const controller = new SheetDrawingUpdateController(
    context,
    h.injector.get(ICommandService),
    h.injector.get(SheetInterceptorService),
    selectionRender,
    h.images,
    { openFile: async () => [], downloadFile: () => {} },
    h.injector.get(ISheetDrawingService),
    h.drawings,
    h.injector.get(IContextService),
    { show: () => ({ dispose: () => {} }), remove: () => {}, removeAll: () => {} },
    h.injector.get(LocaleService),
    selections,
    skeletons,
    h.injector,
    h.urls,
  )
  const attempts: string[] = []
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, value: string) {
    attempts.push(value)
    descriptor?.set?.call(this, value)
    this.width = 120
    this.height = 80
    queueMicrotask(() => this.dispatchEvent(new Event('load')))
  })
  return { ...h, workbook, controller, saveImage, attempts, dispose: () => {
    controller.dispose()
    h.dispose()
  } }
}
