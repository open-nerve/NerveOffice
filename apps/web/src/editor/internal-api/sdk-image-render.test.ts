import { ImageSourceType } from '@univerjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../async-tools.ts'
import { sdkImageHarness, SECOND, SOURCE, THIRD } from './sdk-image-render.test-support.ts'

const cleanup: (() => void)[] = []
function setup() {
  const h = sdkImageHarness()
  cleanup.push(h.dispose)
  return h
}
afterEach(() => {
  for (const finish of cleanup.splice(0))
    finish()
  vi.restoreAllMocks()
})

describe('固定 SDK 浮图只消费受管来源', () => {
  it('URL 服务取消时不创建原地址图元', async () => {
    const h = setup()
    h.getImage.mockRejectedValue(new DOMException('retired', 'AbortError'))
    const attempted = vi.spyOn(HTMLImageElement.prototype, 'src', 'set')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await h.render.renderImages(h.drawing, h.scene)).toEqual([])
    expect(attempted.mock.calls.map(([url]) => url)).not.toContain(SOURCE)
    expect(errors).not.toHaveBeenCalled()
  })

  it.each([ImageSourceType.BASE64, ImageSourceType.UUID])('%s 路径也经服务，创建的元素纳入实例缓存', async (type) => {
    const h = setup()
    const source = type === ImageSourceType.BASE64 ? 'data:image/png;base64,AA==' : 'opaque-id'
    const drawing = h.replace(source, type)
    const result = await h.render.renderImages(drawing, h.scene)
    expect(result).toHaveLength(1)
    expect(result?.[0]?.getNative()?.src).toBe('blob:https://app.test/resolved')
    expect(h.registered.get(source)).toBe(result?.[0]?.getNative())
  })

  it('读取期间场景已退役，迟到的结果不创建图元', async () => {
    const h = setup()
    const pending = deferred<string>()
    h.getImage.mockReturnValue(pending.promise)
    const result = h.render.renderImages(h.drawing, h.scene)
    h.scene.dispose()
    const attempted = vi.spyOn(HTMLImageElement.prototype, 'src', 'set')
    pending.resolve('blob:https://app.test/late')
    expect(await result).toEqual([])
    expect(attempted).not.toHaveBeenCalled()
  })

  it('读取期间模型换源，旧结果不复活旧图片', async () => {
    const h = setup()
    const pending = deferred<string>()
    h.getImage.mockReturnValue(pending.promise)
    const result = h.render.renderImages(h.drawing, h.scene)
    h.replace(SECOND)
    pending.resolve('blob:https://app.test/old')
    expect(await result).toEqual([])
    expect(h.registered.has(SOURCE)).toBe(false)
  })

  it('已有图元换源也走服务，并重新登记实际元素；模型里不写临时地址', async () => {
    const h = setup()
    const [shape] = await h.render.renderImages(h.drawing, h.scene) ?? []
    const next = h.replace(SECOND)
    h.getImage.mockResolvedValue('blob:https://app.test/second')
    await h.render.renderImages(next, h.scene)
    expect(shape?.getNative()?.src).toBe('blob:https://app.test/second')
    expect(h.registered.get(SECOND)).toBe(shape?.getNative())
    expect(h.drawings.getDrawingByParam(next)).toEqual(next)
    expect(JSON.stringify(h.drawings.drawingManagerData)).not.toContain('blob:')
  })

  it('连续换源逆序返回时只保留最后一张', async () => {
    const h = setup()
    const [shape] = await h.render.renderImages(h.drawing, h.scene) ?? []
    const slow = deferred<string>()
    h.getImage.mockReturnValueOnce(slow.promise)
    const first = h.render.renderImages(h.replace(SECOND), h.scene)
    h.getImage.mockResolvedValue('blob:https://app.test/third')
    await h.render.renderImages(h.replace(THIRD), h.scene)
    slow.resolve('blob:https://app.test/second')
    await first
    expect(shape?.getNative()?.src).toBe('blob:https://app.test/third')
  })
})
