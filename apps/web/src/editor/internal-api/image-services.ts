import type { DependencyOverride, Univer } from '@univerjs/core'
import { IImageIoService, IURLImageService } from '@univerjs/core'
import { IRenderManagerService } from '@univerjs/engine-render'
import { IGalleryService } from '@univerjs/ui'
import { injectorOf } from './injector.ts'

/** 图库自己持有解码后的元素；权限刷新时一并关掉，不能仅撤销源 blob URL。 */
export function closeImagePreview(univer: Univer): void {
  const injector = injectorOf(univer)
  if (injector.has(IGalleryService))
    injector.get(IGalleryService).close()
}

export function imageServiceOverride(images: IImageIoService, urls: IURLImageService): DependencyOverride {
  return [[IImageIoService, { useValue: images }], [IURLImageService, { useValue: urls }]]
}

/** 仅请求当前画面重绘；不写模型、命令或变更序号，也不为失败创建中的实例启动渲染插件。 */
export function invalidateImageRendering(univer: Univer): void {
  const injector = injectorOf(univer)
  if (!injector.has(IRenderManagerService))
    return
  for (const render of injector.get(IRenderManagerService).getRenderAll().values()) {
    if (!render.isDisposed())
      render.scene.makeDirty(true)
  }
}
