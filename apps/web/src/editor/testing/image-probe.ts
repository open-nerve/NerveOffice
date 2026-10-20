import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { installSystemImageInput } from '../images/system-image-input.ts'
import { classifyImageInput } from '../images/image-input-policy.ts'
import { getDrawingShapeKeyByDrawingSearch, IDrawingManagerService, injectorOf } from '../internal-api/index.ts'
import { IImageIoService, ImageSourceType, invalidateImageRendering, IRenderManagerService, RenderImage } from '../internal-api/ui.ts'

/** 仅调用和观察正式实例的实际服务；不安装替代 IO，也不创建测试用 SDK 图元。 */
export function createImageProbe(univer: Univer, workbook: ReturnType<FUniver['createWorkbook']>, input?: ReturnType<typeof installSystemImageInput>) {
  const injector = injectorOf(univer)
  return {
    input,
    classify: classifyImageInput,
    selected: () => injector.get(IDrawingManagerService).getFocusDrawings().map(image => image.drawingId),
    upload: async (file: File) => injector.get(IImageIoService).saveImage(file),
    element: (drawingId: string): HTMLImageElement | undefined => {
      const unitId = workbook.getId()
      const subUnitId = workbook.getActiveSheet().getSheetId()
      const scene = injector.get(IRenderManagerService).getRenderUnitById(unitId)?.scene
      const object = scene?.getObject(getDrawingShapeKeyByDrawingSearch({ unitId, subUnitId, drawingId }))
      return object instanceof RenderImage ? object.getNative() ?? undefined : undefined
    },
    cached: (source: string): HTMLImageElement | undefined => injector.get(IImageIoService).getImageSourceCache(source, ImageSourceType.URL) ?? undefined,
    redraw: () => invalidateImageRendering(univer),
  }
}
