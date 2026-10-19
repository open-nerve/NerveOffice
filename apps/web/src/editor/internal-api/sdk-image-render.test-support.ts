import type { IImageIoService, IURLImageService } from '@univerjs/core'
import type { IImageData } from '@univerjs/drawing'
import { DrawingTypeEnum, ImageSourceType, IUniverInstanceService, Univer } from '@univerjs/core'
import { IDrawingManagerService, UniverDrawingPlugin } from '@univerjs/drawing'
import { DrawingImageClipService, DrawingRenderService } from '@univerjs/drawing-ui'
import { Scene, SceneViewer } from '@univerjs/engine-render'
import { DesktopGalleryService, UIPartsService } from '@univerjs/ui'
import { EMPTY } from 'rxjs'
import { vi } from 'vitest'
import { imageServiceOverride } from './image-services.ts'
import { injectorOf } from './injector.ts'

export const SOURCE = '/api/assets/11111111-1111-4111-8111-111111111111.png'
export const SECOND = '/api/assets/22222222-2222-4222-8222-222222222222.png'
export const THIRD = '/api/assets/33333333-3333-4333-8333-333333333333.png'

export function sdkImageHarness() {
  const getImage = vi.fn(async (_source: string) => 'blob:https://app.test/resolved')
  const registered = new Map<string, HTMLImageElement>()
  const images: IImageIoService = {
    change$: EMPTY,
    setWaitCount: () => {},
    getImage,
    saveImage: async () => null,
    getImageSourceCache: () => undefined,
    addImageSourceCache: (source, _type, image) => {
      if (image)
        registered.set(source, image)
    },
  }
  const urls: IURLImageService = { getImage, downloadImage: async () => new Blob(), registerURLImageDownloader: () => ({ dispose: () => {} }) }
  const univer = new Univer()
  univer.registerPlugin(UniverDrawingPlugin, { override: imageServiceOverride(images, urls) })
  const injector = injectorOf(univer)
  const drawings = injector.get(IDrawingManagerService)
  drawings.setDrawingEditable(false)
  const parts = new UIPartsService()
  const gallery = new DesktopGalleryService(injector, parts)
  const clips = new DrawingImageClipService()
  const render = new DrawingRenderService(drawings, images, gallery, urls, injector.get(IUniverInstanceService), clips)
  // 真实 SceneViewer/Scene 不创建浏览器画布；画布与实际像素由三浏览器回归负责。
  const viewer = new SceneViewer('viewer')
  const scene = new Scene('scene', viewer, { width: 800, height: 600 })
  const drawing: IImageData = {
    unitId: 'book',
    subUnitId: 'sheet',
    drawingId: 'image',
    drawingType: DrawingTypeEnum.DRAWING_IMAGE,
    imageSourceType: ImageSourceType.URL,
    source: SOURCE,
    transform: { left: 10, top: 20, width: 120, height: 80 },
  }
  drawings.setDrawingData('book', 'sheet', { image: drawing })
  return {
    univer,
    injector,
    images,
    urls,
    getImage,
    registered,
    drawings,
    render,
    viewer,
    scene,
    drawing,
    replace: (source: string, type = ImageSourceType.URL) => {
      const next = { ...drawing, source, imageSourceType: type }
      drawings.setDrawingData('book', 'sheet', { image: next })
      return next
    },
    dispose: () => {
      scene.dispose()
      viewer.dispose()
      gallery.dispose()
      parts.dispose()
      clips.dispose()
      univer.dispose()
    },
  }
}
