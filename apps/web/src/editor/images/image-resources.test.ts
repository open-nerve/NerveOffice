import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetInputError, AssetReadError } from '../../shared/assets/asset-api.ts'
import { deferred } from '../async-tools.ts'
import { BYTES, decoded, OTHER, PLACEHOLDER, resourcesHarness, SOURCE } from './image-resources.test-support.ts'

beforeEach(() => vi.stubGlobal('Blob', NodeBlob))
afterEach(() => vi.restoreAllMocks())

describe('实例图片资源读取', () => {
  it('相对和本站绝对地址共用同代读取，向请求层只交相对地址', async () => {
    const h = resourcesHarness()
    const first = h.resources.load(SOURCE)
    const second = h.resources.load(`https://app.test${SOURCE}`)
    expect(await first).toBe('blob:https://app.test/first')
    expect(await second).toBe('blob:https://app.test/first')
    expect(h.read).toHaveBeenCalledExactlyOnceWith(SOURCE, expect.any(AbortSignal))
    expect(h.resources.cached(SOURCE)?.src).toBe('blob:https://app.test/first')
    expect(await h.resources.load(SOURCE)).toBe('blob:https://app.test/first')
    expect(h.read).toHaveBeenCalledTimes(1)
    h.resources.dispose()
  })

  it.each([`https://evil.test${SOURCE}`, `//app.test${SOURCE}`, `${SOURCE}?x=1`, `${SOURCE}#x`, `${SOURCE}/`, 'blob:https://app.test/arbitrary', 'data:image/png;base64,AA==', '/api/assets/not-a-uuid'])('非法来源 %s 不发请求且不下载占位', async (source) => {
    const h = resourcesHarness()
    expect(await h.resources.load(source)).toBe(PLACEHOLDER)
    await expect(h.resources.download(source)).rejects.toBeInstanceOf(AssetInputError)
    expect(h.read).not.toHaveBeenCalled()
    expect(h.resources.cached(source)).toBeUndefined()
    h.resources.dispose()
  })

  it.each([new AssetReadError(404, undefined), new AssetReadError(500, undefined), new AssetReadError(503, 30), new Error('decode failed')])('失败 %s 一代只读和报告一次，不把占位当缓存原图', async (error) => {
    const h = resourcesHarness()
    h.read.mockRejectedValue(error)
    expect(await h.resources.load(SOURCE)).toBe(PLACEHOLDER)
    expect(await h.resources.load(SOURCE)).toBe(PLACEHOLDER)
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.failed).toHaveBeenCalledExactlyOnceWith(error)
    expect(h.resources.cached(SOURCE)).toBeUndefined()
    h.resources.dispose()
  })

  it('不同实例不共享同地址的字节、解码元素或生命周期', async () => {
    const a = resourcesHarness()
    const b = resourcesHarness()
    await Promise.all([a.resources.load(SOURCE), b.resources.load(SOURCE)])
    expect(a.resources.cached(SOURCE)).not.toBe(b.resources.cached(SOURCE))
    a.resources.dispose()
    expect(b.resources.cached(SOURCE)?.src).toBe('blob:https://app.test/first')
    expect(a.read).toHaveBeenCalledTimes(1)
    expect(b.read).toHaveBeenCalledTimes(1)
    b.resources.dispose()
  })

  it('下载每次重新读且验证解码，显示缓存和占位不能充当原文件', async () => {
    const h = resourcesHarness()
    const display = decoded('blob:https://app.test/display')
    const download1 = decoded('blob:https://app.test/download-1')
    const download2 = decoded('blob:https://app.test/download-2')
    h.decode.mockResolvedValueOnce(display).mockResolvedValueOnce(download1).mockResolvedValueOnce(download2)
    await h.resources.load(SOURCE)
    const one = await h.resources.download(SOURCE)
    const two = await h.resources.download(SOURCE)
    expect(new Uint8Array(await one.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(two.type).toBe('image/png')
    expect(h.read).toHaveBeenCalledTimes(3)
    expect(download1.dispose).toHaveBeenCalledTimes(1)
    expect(download2.dispose).toHaveBeenCalledTimes(1)
    expect(display.dispose).not.toHaveBeenCalled()
    h.read.mockRejectedValueOnce(new AssetReadError(404, undefined))
    await expect(h.resources.download(SOURCE)).rejects.toMatchObject({ status: 404 })
    h.resources.dispose()
  })

  it('坏图下载直接拒绝，不交出原字节或占位', async () => {
    const h = resourcesHarness()
    h.decode.mockRejectedValue(new Error('controlled decode failure'))
    await expect(h.resources.download(SOURCE)).rejects.toThrow('controlled decode failure')
    expect(h.read).toHaveBeenCalledTimes(1)
    h.resources.dispose()
  })

  it('登记的 SDK 元素只能显示已确认地址，刷新先清旧图再换新图', async () => {
    const h = resourcesHarness()
    const old = decoded()
    h.decode.mockResolvedValueOnce(old).mockResolvedValue(decoded('blob:https://app.test/second'))
    await h.resources.load(SOURCE)
    const image = document.createElement('img')
    image.src = `https://app.test${SOURCE}`
    h.resources.track(SOURCE, image)
    expect(image.src).toBe('blob:https://app.test/first')
    h.resources.refresh()
    expect(image.src).toBe(PLACEHOLDER)
    expect(old.dispose).toHaveBeenCalledTimes(1)
    expect(await h.resources.load(SOURCE)).toBe('blob:https://app.test/second')
    expect(image.src).toBe('blob:https://app.test/second')
    expect(h.changed).toHaveBeenCalled()
    h.resources.dispose()
    expect(image.src).toBe(PLACEHOLDER)
  })

  it('同一个 SDK 元素换来源后，旧来源的迟到结果不能把它改回去', async () => {
    const pending = deferred<typeof BYTES>()
    const h = resourcesHarness()
    h.read.mockImplementation(async source => source === SOURCE ? pending.promise : BYTES)
    h.decode.mockResolvedValue(decoded('blob:https://app.test/new-source'))
    const image = document.createElement('img')
    const old = h.resources.load(SOURCE)
    h.resources.track(SOURCE, image)
    await h.resources.load(OTHER)
    h.resources.track(OTHER, image)
    expect(image.src).toBe('blob:https://app.test/new-source')
    h.decode.mockResolvedValueOnce(decoded('blob:https://app.test/old-source'))
    pending.resolve(BYTES)
    await old
    expect(image.src).toBe('blob:https://app.test/new-source')
    h.resources.dispose()
  })
})
