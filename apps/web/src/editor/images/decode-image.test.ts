import type { AssetBytes } from '../../shared/assets/asset-api.ts'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../async-tools.ts'
import { decodeImage, ImageDecodeError } from './decode-image.ts'

const PNG: AssetBytes = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }
const created: HTMLImageElement[] = []
let width = 120
let height = 80
let complete = true
let decode = async (): Promise<void> => {}
const makeUrl = vi.fn<(blob: Blob) => string>(() => 'blob:https://app.test/decoded')
const revokeUrl = vi.fn()

beforeEach(() => {
  width = 120
  height = 80
  complete = true
  decode = async () => {}
  created.length = 0
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: makeUrl, revokeObjectURL: revokeUrl }))
  // jsdom 不解码像素；保留真实元素的 src/属性行为，只控制浏览器解码完成与几何结果。
  vi.stubGlobal('Image', class TestImage {
    constructor() {
      const element = document.createElement('img')
      Object.defineProperties(element, {
        complete: { get: () => complete },
        naturalWidth: { get: () => width },
        naturalHeight: { get: () => height },
        decode: { value: async () => decode() },
      })
      created.push(element)
      return element
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('浏览器图片解码的所有权', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const)('成功的 %s 只在 dispose 时撤销，重复清理无副作用', async (mimeType) => {
    const result = await decodeImage({ ...PNG, mimeType }, new AbortController().signal)
    expect(result.url).toBe('blob:https://app.test/decoded')
    expect(result.image.src).toBe(result.url)
    expect(result.image.naturalWidth).toBe(120)
    const blob: Blob | undefined = makeUrl.mock.calls[0]?.[0]
    expect(blob?.type).toBe(mimeType)
    expect(blob?.size).toBe(3)
    expect(revokeUrl).not.toHaveBeenCalled()
    result.dispose()
    result.dispose()
    expect(result.image.hasAttribute('src')).toBe(false)
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(result.url)
  })

  it.each([0, 5 * 1024 * 1024 + 1])('字节数 %s 在创建对象 URL 之前拒绝', async (size) => {
    await expect(decodeImage({ ...PNG, data: new Uint8Array(size) }, new AbortController().signal)).rejects.toMatchObject({ reason: 'invalid' })
    expect(makeUrl).not.toHaveBeenCalled()
  })

  it('接受 5 MiB 的边界', async () => {
    const result = await decodeImage({ ...PNG, data: new Uint8Array(5 * 1024 * 1024) }, new AbortController().signal)
    result.dispose()
    expect(revokeUrl).toHaveBeenCalledTimes(1)
  })

  it.each([[0, 80], [120, 0], [8193, 1], [1, 8193], [4001, 4000]])('拒绝无效或超限尺寸 %s×%s 并释放临时资源', async (w, h) => {
    width = w
    height = h
    await expect(decodeImage(PNG, new AbortController().signal)).rejects.toMatchObject({ reason: 'dimensions' })
    expect(revokeUrl).toHaveBeenCalledTimes(1)
    expect(created[0]?.hasAttribute('src')).toBe(false)
  })

  it.each([[8192, 1], [1, 8192], [4000, 4000]])('接受合法尺寸边界 %s×%s', async (w, h) => {
    width = w
    height = h
    const result = await decodeImage(PNG, new AbortController().signal)
    expect(result.image.naturalWidth * result.image.naturalHeight).toBe(w * h)
    result.dispose()
  })

  it('未完成的元素不作为已解码图片交出', async () => {
    complete = false
    await expect(decodeImage(PNG, new AbortController().signal)).rejects.toBeInstanceOf(ImageDecodeError)
    expect(revokeUrl).toHaveBeenCalledTimes(1)
  })

  it('破损字节解码失败，错误不回显字节与底层内容', async () => {
    decode = async () => {
      throw new Error('controlled sensitive detail')
    }
    await expect(decodeImage(PNG, new AbortController().signal)).rejects.toMatchObject({ name: 'ImageDecodeError', reason: 'invalid', message: '图片无法显示' })
    expect(revokeUrl).toHaveBeenCalledTimes(1)
    expect(created[0]?.hasAttribute('src')).toBe(false)
  })

  it('预取消保留原原因，不分配资源', async () => {
    const controller = new AbortController()
    const reason = { retired: true }
    controller.abort(reason)
    await expect(decodeImage(PNG, controller.signal)).rejects.toBe(reason)
    expect(makeUrl).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'timeout'] as const)('%s 及时结束；不响应取消的解码晚成功不能复活 src', async (stop) => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    decode = async () => pending.promise
    const controller = new AbortController()
    const reason = { retired: true }
    let outcome: unknown
    const task = decodeImage(PNG, controller.signal).then((value) => {
      outcome = value
    }, (error: unknown) => {
      outcome = error
    })
    await vi.advanceTimersByTimeAsync(9999)
    expect(outcome).toBeUndefined()
    if (stop === 'cancel')
      controller.abort(reason)
    else
      await vi.advanceTimersByTimeAsync(1)
    await task
    if (stop === 'cancel')
      expect(outcome).toBe(reason)
    else
      expect(outcome).toMatchObject({ reason: 'timeout' })
    expect(revokeUrl).toHaveBeenCalledTimes(1)
    expect(created[0]?.hasAttribute('src')).toBe(false)
    pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(created[0]?.hasAttribute('src')).toBe(false)
    expect(revokeUrl).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
