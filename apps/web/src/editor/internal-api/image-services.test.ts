import type { IRender } from '@univerjs/engine-render'
import { Univer } from '@univerjs/core'
import { IRenderManagerService, UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { DesktopGalleryService, IGalleryService, UIPartsService } from '@univerjs/ui'
import { describe, expect, it, vi } from 'vitest'
import { closeImagePreview, invalidateImageRendering } from './image-services.ts'
import { injectorOf } from './injector.ts'

vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

describe('图片状态只使仍存活的场景重绘', () => {
  it('渲染插件尚未启动时不创建它，不报错', () => {
    const univer = new Univer()
    expect(() => invalidateImageRendering(univer)).not.toThrow()
    expect(injectorOf(univer).has(IRenderManagerService)).toBe(false)
    univer.dispose()
  })

  it('通过真实注入器找到服务，仅通知仍存活的渲染单元', () => {
    const univer = new Univer()
    univer.registerPlugin(UniverRenderEnginePlugin)
    const active = vi.fn()
    const retired = vi.fn()
    // 不在 jsdom 里建立画布。此边界只读取场景/退役标志；实际 SDK dirty 与像素由浏览器回归验收。
    const renders = new Map<string, Pick<IRender, 'isDisposed'> & { scene: { makeDirty: typeof active } }>([
      ['active', { isDisposed: () => false, scene: { makeDirty: active } }],
      ['retired', { isDisposed: () => true, scene: { makeDirty: retired } }],
    ])
    const manager = injectorOf(univer).get(IRenderManagerService)
    for (const [key, value] of renders)
      manager.getRenderAll().set(key, value as unknown as IRender)
    try {
      invalidateImageRendering(univer)
      expect(active).toHaveBeenCalledExactlyOnceWith(true)
      expect(retired).not.toHaveBeenCalled()
    }
    finally {
      manager.getRenderAll().clear()
      univer.dispose()
    }
  })
})

it('图片许可失效关闭该实例真实图库，并清空图库持有的图片列表', () => {
  const univer = new Univer()
  const injector = injectorOf(univer)
  const parts = new UIPartsService()
  const gallery = new DesktopGalleryService(injector, parts)
  injector.add([IGalleryService, { useValue: gallery }])
  const states: { open: boolean | undefined, images: string[] | undefined }[] = []
  const subscription = gallery.gallery$.subscribe(state => states.push({ open: state.open, images: state.images }))
  try {
    gallery.open({ images: ['blob:https://app.test/preview'] })
    expect(states.at(-1)?.open).toBe(true)
    closeImagePreview(univer)
    expect(states.at(-1)).toEqual({ open: false, images: [] })
  }
  finally {
    subscription.unsubscribe()
    gallery.dispose()
    parts.dispose()
    univer.dispose()
  }
})
