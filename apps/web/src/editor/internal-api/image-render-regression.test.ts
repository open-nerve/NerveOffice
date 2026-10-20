import type { UniverRenderingContext } from '@univerjs/engine-render'
import { Image as DrawingImage } from '@univerjs/engine-render'
import { describe, expect, it, vi } from 'vitest'

function nativeImage(complete: boolean, width: number, height: number) {
  const native = document.createElement('img')
  native.src = 'blob:https://app.test/render'
  Object.defineProperties(native, { complete: { value: complete }, naturalWidth: { value: width }, naturalHeight: { value: height } })
  return native
}

function canvasBoundary() {
  const drawImage = vi.fn()
  const methods = { save: vi.fn(), restore: vi.fn(), transform: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), translate: vi.fn(), drawImage }
  // jsdom 无 Canvas2D。只替代实际绘图边界；调用任何未声明能力都失败，不能悄悄吞掉 SDK 的新要求。
  const context = new Proxy(methods, { get: (target, key) => {
    if (!(key in target))
      throw new Error(`未声明的绘制边界：${String(key)}`)
    return target[key as keyof typeof target]
  } }) as unknown as UniverRenderingContext
  return { context, drawImage }
}

describe('UR-006：破图不进入 Canvas 绘制，也不吞其他画布错误', () => {
  it.each([[false, 120, 80], [true, 0, 0], [true, 120, 0]] as const)('complete=%s，%sx%s：后续正常图仍能绘制', (complete, width, height) => {
    const bad = nativeImage(complete, width, height)
    const good = nativeImage(true, 120, 80)
    const broken = new DrawingImage('bad', { image: bad, width: 120, height: 80 })
    const normal = new DrawingImage('normal', { image: good, width: 120, height: 80 })
    const c = canvasBoundary()
    c.drawImage.mockImplementation((source: CanvasImageSource) => {
      if (source === bad)
        throw new DOMException('broken image', 'InvalidStateError')
    })
    try {
      expect(() => broken.render(c.context)).not.toThrow()
      normal.render(c.context)
      expect(c.drawImage).toHaveBeenCalledExactlyOnceWith(good, -60, -40, 120, 80)
    }
    finally {
      broken.dispose()
      normal.dispose()
    }
  })

  it('正常裁剪图保留实际裁剪坐标', () => {
    const native = nativeImage(true, 120, 80)
    const image = new DrawingImage('crop', { image: native, width: 120, height: 80 })
    image.setSrcRect({ left: 10, right: 20, top: 5, bottom: 15 })
    const c = canvasBoundary()
    try {
      image.render(c.context)
      expect(c.drawImage).toHaveBeenCalledExactlyOnceWith(native, -70, -45, 150, 100)
    }
    finally {
      image.dispose()
    }
  })

  it('非图片状态导致的画布异常照常传播', () => {
    const image = new DrawingImage('normal', { image: nativeImage(true, 120, 80), width: 120, height: 80 })
    const c = canvasBoundary()
    const error = new Error('canvas backend failed')
    c.drawImage.mockImplementation(() => {
      throw error
    })
    try {
      expect(() => image.render(c.context)).toThrow(error)
    }
    finally {
      image.dispose()
    }
  })
})
