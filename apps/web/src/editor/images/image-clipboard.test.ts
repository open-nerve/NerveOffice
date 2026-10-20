import type { ImageClipboardReader } from './image-clipboard.ts'
import { Blob as NodeBlob } from 'node:buffer'
import { ASSET_MAX_BYTES } from '@nerve-office/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../async-tools.ts'
import { decodeImage } from './decode-image.ts'
import { writeSystemImage } from './image-clipboard.ts'
import { BYTES, decoded, SOURCE } from './image-resources.test-support.ts'

vi.mock('./decode-image.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./decode-image.ts')>()
  return { ...actual, decodeImage: vi.fn() }
})

const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>()
const read = vi.fn<ImageClipboardReader>()
let image = decoded()

beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('ClipboardItem', class {
    readonly types: readonly string[]
    readonly presentationStyle = 'unspecified'
    readonly data: Record<string, Promise<Blob>>
    constructor(data: Record<string, Promise<Blob>>) {
      this.data = data
      this.types = Object.keys(data)
    }

    async getType(type: string): Promise<Blob> {
      const value = this.data[type]
      if (value === undefined)
        return Promise.reject(new DOMException('missing', 'NotFoundError'))
      return value
    }
  })
  vi.stubGlobal('navigator', { clipboard: { write } })
  write.mockReset().mockImplementation(async (items) => {
    for (const item of items)
      await item.getType('image/png')
  })
  read.mockReset().mockResolvedValue(BYTES)
  image = decoded()
  vi.mocked(decodeImage).mockReset().mockResolvedValue(image)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function encoding(result: Blob | null = new Blob([new Uint8Array([7, 8])], { type: 'image/png' })) {
  const draw = vi.fn()
  const context = new Proxy({}, { get: (_target, key) => {
    if (key === 'drawImage')
      return draw
    throw new Error(`未声明的画布依赖：${String(key)}`)
  } }) as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(result))
  return { draw, encode }
}

describe('同步系统写入与可取消的真实图片准备', () => {
  it('read 延迟时已在原同步调用栈 write；PNG 验证后保持原字节，不写空文本', async () => {
    const pending = deferred<typeof BYTES>()
    read.mockReturnValueOnce(pending.promise)
    const result = writeSystemImage(SOURCE, new AbortController().signal, read).then(() => 'written', (error: unknown) => error)
    expect(write).toHaveBeenCalledOnce()
    const item = write.mock.calls[0]?.[0][0]
    expect(item?.types).toEqual(['image/png'])
    pending.resolve(BYTES)
    expect(await result).toBe('written')
    const blob = await item?.getType('image/png')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(BYTES.data)
    expect(image.dispose).toHaveBeenCalledOnce()
  })

  it.each(['image/jpeg', 'image/webp', 'image/gif'] as const)('%s 用解码后的实际尺寸导出静态 PNG 并释放元素和画布', async (mimeType) => {
    read.mockResolvedValueOnce({ ...BYTES, mimeType })
    const h = encoding()
    await writeSystemImage(SOURCE, new AbortController().signal, read)
    expect(h.draw).toHaveBeenCalledWith(image.image, 0, 0)
    expect(h.encode).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 'image/png')
    const blob = await write.mock.calls[0]?.[0][0]?.getType('image/png')
    expect(blob?.type).toBe('image/png')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([7, 8]))
    expect(h.encode.mock.contexts[0]).toMatchObject({ width: 0, height: 0 })
    expect(image.dispose).toHaveBeenCalledOnce()
  })

  it('剪贴板拒绝及时取消原图读取，不等迟到网络，也能再次尝试', async () => {
    const pending = deferred<typeof BYTES>()
    read.mockReturnValueOnce(pending.promise)
    const denied = new DOMException('denied', 'NotAllowedError')
    write.mockRejectedValueOnce(denied)
    await expect(writeSystemImage(SOURCE, new AbortController().signal, read)).rejects.toBe(denied)
    expect(read.mock.calls[0]?.[1].aborted).toBe(true)
    pending.resolve(BYTES)
    await writeSystemImage(SOURCE, new AbortController().signal, read)
    expect(write).toHaveBeenCalledTimes(2)
    expect(decodeImage).toHaveBeenCalledOnce()
  })

  it.each(['read', 'decode'] as const)('%s 失败时 ClipboardItem 同样拒绝，不会输出占位内容', async (stage) => {
    const error = new Error('controlled internal detail')
    if (stage === 'read')
      read.mockRejectedValueOnce(error)
    else
      vi.mocked(decodeImage).mockRejectedValueOnce(error)
    await expect(writeSystemImage(SOURCE, new AbortController().signal, read)).rejects.toBe(error)
    const item = write.mock.calls[0]?.[0][0]
    await expect(item?.getType('image/png')).rejects.toBe(error)
  })

  it.each([null, 0, ASSET_MAX_BYTES + 1])('空值或超限 PNG 输出 %s 拒绝且释放资源', async (size) => {
    read.mockResolvedValueOnce({ ...BYTES, mimeType: 'image/jpeg' })
    encoding(size === null ? null : new Blob([new Uint8Array(size)], { type: 'image/png' }))
    await expect(writeSystemImage(SOURCE, new AbortController().signal, read)).rejects.toMatchObject({ name: 'ImageClipboardError' })
    expect(image.dispose).toHaveBeenCalledOnce()
  })

  it('10 秒仍未编码则及时失败，迟到回调不会写入第二次', async () => {
    vi.useFakeTimers()
    read.mockResolvedValueOnce({ ...BYTES, mimeType: 'image/jpeg' })
    const h = encoding()
    let finish: BlobCallback | undefined
    h.encode.mockImplementation((callback) => {
      finish = callback
    })
    const result = writeSystemImage(SOURCE, new AbortController().signal, read).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({ name: 'ImageClipboardError', reason: 'timeout' })
    expect(image.dispose).toHaveBeenCalledOnce()
    finish?.(new Blob([new Uint8Array([1])], { type: 'image/png' }))
    expect(write).toHaveBeenCalledOnce()
  })

  it('写入永久不返回也响应调用方取消；预取消或缺少 API 时零读取', async () => {
    const controller = new AbortController()
    write.mockImplementationOnce(async () => deferred<void>().promise)
    const result = writeSystemImage(SOURCE, controller.signal, read).catch((error: unknown) => error)
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    read.mockClear()
    write.mockClear()
    await expect(writeSystemImage(SOURCE, controller.signal, read)).rejects.toMatchObject({ name: 'AbortError' })
    vi.stubGlobal('ClipboardItem', undefined)
    await expect(writeSystemImage(SOURCE, new AbortController().signal, read)).rejects.toMatchObject({ reason: 'unsupported' })
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})
