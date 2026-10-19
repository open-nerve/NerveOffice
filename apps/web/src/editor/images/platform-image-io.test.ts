import type { AssetUploadResponse, SessionResponse } from '@nerve-office/contracts'
import type { EditorAccess } from '../editor-access.ts'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { ImageCacheMap, Univer } from '@univerjs/core'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAsset, uploadAsset } from '../../shared/assets/asset-api.ts'
import { deferred } from '../async-tools.ts'
import { injectorOf } from '../internal-api/index.ts'
import { IImageIoService, ImageSourceType, IURLImageService } from '../internal-api/ui.ts'
import { sheetPluginEntries } from '../profile/sheet-profile.ts'
import { decodeImage } from './decode-image.ts'
import { BYTES, decoded, SOURCE } from './image-resources.test-support.ts'
import { createPlatformImageIo } from './platform-image-io.ts'

vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})
vi.mock('../../shared/assets/asset-api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/assets/asset-api.ts')>()
  return { ...actual, readAsset: vi.fn(), uploadAsset: vi.fn() }
})
// jsdom 没有像素解码；代次/缓存仍用真实资源表，decode 的真实行为另有单元和浏览器回归。
vi.mock('./decode-image.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./decode-image.ts')>()
  return { ...actual, decodeImage: vi.fn() }
})

const UPLOADED: AssetUploadResponse = { assetId: '11111111-1111-4111-8111-111111111111', url: SOURCE, width: 120, height: 80, bytes: 3, mimeType: 'image/png' }
const cleanup: (() => void)[] = []

function session(token = 'original'): SessionResponse {
  return { user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '甲' }, csrfToken: token, features: { localDraftsEnabled: true } }
}

function setup(access: EditorAccess = 'edit', initial: SessionResponse | null = session(), owner?: string) {
  let current: SessionResponse | undefined = initial ?? undefined
  const listeners = new Set<() => void>()
  const failed = vi.fn()
  const invalidated = vi.fn()
  const adapter = createPlatformImageIo({
    access,
    identity: {
      ...(owner === undefined ? {} : { owner }),
      current: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    origin: 'https://app.test',
    changed: vi.fn(),
    failed,
    invalidated,
  })
  const univer = new Univer()
  univer.registerPlugin(UniverDrawingPlugin, { override: adapter.override })
  cleanup.push(() => {
    adapter.dispose()
    univer.dispose()
  })
  const injector = injectorOf(univer)
  return {
    adapter,
    injector,
    original: initial,
    image: injector.get(IImageIoService),
    url: injector.get(IURLImageService),
    failed,
    invalidated,
    listeners,
    change: (next: SessionResponse | undefined) => {
      current = next
      for (const listener of listeners)
        listener()
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  vi.mocked(readAsset).mockResolvedValue(BYTES)
  vi.mocked(uploadAsset).mockResolvedValue(UPLOADED)
  vi.mocked(decodeImage).mockImplementation(async () => decoded())
})

describe('SDK 单元格缓存属于当前图片实例', () => {
  it('第一次读取中途换代，预先登记的元素能接收新代次结果，不需要 SDK 再次查询', async () => {
    const h = setup()
    const slow = deferred<typeof BYTES>()
    vi.mocked(readAsset).mockReturnValueOnce(slow.promise)
    const cache = new ImageCacheMap(h.injector)
    cache.getImage(ImageSourceType.URL, SOURCE)
    const image = cache.getImage(ImageSourceType.URL, SOURCE)
    expect(image).not.toBeNull()
    h.change(session('renewed'))
    await vi.waitFor(() => expect(image?.src).toBe('blob:https://app.test/first'))
    expect(readAsset).toHaveBeenCalledTimes(2)
    slow.resolve(BYTES)
  })

  it('创建时许可已暂停，仍绑定页面所有者：不能被另一用户激活，本人返回后可恢复', async () => {
    const original = session()
    const h = setup('read', null, original.user.id)
    await expect(h.url.getImage(SOURCE)).rejects.toMatchObject({ name: 'AbortError' })
    h.change({ ...original, user: { ...original.user, id: 'other-user' } })
    await expect(h.url.getImage(SOURCE)).rejects.toMatchObject({ name: 'AbortError' })
    expect(readAsset).not.toHaveBeenCalled()
    h.change(original)
    await expect(h.url.getImage(SOURCE)).resolves.toBe('blob:https://app.test/first')
    expect(vi.mocked(readAsset).mock.calls.at(-1)?.[1]?.session).toBe(original)
  })

  it('未提供所有者也没有初始身份时永久关闭，不能由后来第一个人认领', async () => {
    const h = setup('read', null)
    h.change(session())
    await expect(h.url.getImage(SOURCE)).rejects.toMatchObject({ name: 'AbortError' })
    expect(readAsset).not.toHaveBeenCalled()
  })

  it('富文本图片元素随身份撤回同步清空，不能只撤销 blob URL', async () => {
    const h = setup()
    const cache = new ImageCacheMap(h.injector)
    cache.getImage(ImageSourceType.URL, SOURCE)
    await new Promise(resolve => setTimeout(resolve, 0))
    const image = cache.getImage(ImageSourceType.URL, SOURCE)
    expect(image?.src).toBe('blob:https://app.test/first')
    h.change(undefined)
    expect(image?.src).not.toBe('blob:https://app.test/first')
    expect(cache.getImage(ImageSourceType.URL, SOURCE)).toBe(image)
  })

  it('读取取消后没有原 URL 的直接请求', async () => {
    const h = setup()
    vi.mocked(readAsset).mockImplementation(async () => deferred<never>().promise)
    const attempted = vi.spyOn(HTMLImageElement.prototype, 'src', 'set')
    const cache = new ImageCacheMap(h.injector)
    cache.getImage(ImageSourceType.URL, SOURCE)
    h.change(undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(attempted.mock.calls.map(([url]) => url)).not.toContain(SOURCE)
  })

  it('富文本的内嵌来源也经过实例服务，不直接交给浏览器', async () => {
    const h = setup()
    const source = 'data:image/png;base64,AA=='
    const attempted = vi.spyOn(HTMLImageElement.prototype, 'src', 'set')
    const cache = new ImageCacheMap(h.injector)
    cache.getImage(ImageSourceType.BASE64, source)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(attempted.mock.calls.map(([url]) => url)).not.toContain(source)
    expect(readAsset).not.toHaveBeenCalled()
    expect(cache.getImage(ImageSourceType.BASE64, source)?.src).toMatch(/unavailable\.svg/)
  })

  it('在设置图片来源前挂好加载回调，缓存命中也能通知绘制', async () => {
    const h = setup()
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
    const observed: boolean[] = []
    vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, url: string) {
      if (url === 'blob:https://app.test/first')
        observed.push(typeof this.onload === 'function' && typeof this.onerror === 'function')
      descriptor?.set?.call(this, url)
    })
    const loaded = vi.fn()
    const cache = new ImageCacheMap(h.injector)
    cache.getImage(ImageSourceType.URL, SOURCE, loaded)
    await new Promise(resolve => setTimeout(resolve, 0))
    const image = cache.getImage(ImageSourceType.URL, SOURCE)
    image?.dispatchEvent(new Event('load'))
    // decode 替身创建原件时没有回调；最后一次赋值才是 SDK 的富文本元素。
    expect(observed.at(-1)).toBe(true)
    expect(loaded).toHaveBeenCalledOnce()
  })
})

afterEach(() => {
  for (const finish of cleanup.splice(0))
    finish()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('真实 drawing 插件中的平台 IO', () => {
  it('许可刷新和退役立即关闭预览，普通图片加载不关闭用户正在看的预览', async () => {
    const h = setup()
    await h.url.getImage(SOURCE)
    expect(h.invalidated).not.toHaveBeenCalled()
    h.change(session('renewed'))
    expect(h.invalidated).toHaveBeenCalledTimes(1)
    h.adapter.dispose()
    expect(h.invalidated).toHaveBeenCalledTimes(2)
    h.adapter.dispose()
    expect(h.invalidated).toHaveBeenCalledTimes(2)
  })
  it('当前表格档案将两个平台服务交给 drawing 插件，而不是核心 override', () => {
    const h = setup()
    const univer = new Univer()
    cleanup.push(() => univer.dispose())
    const entries = sheetPluginEntries({ container: document.createElement('div'), formula: { kind: 'main-thread' }, access: 'edit', imageOverride: h.adapter.override })
    const drawing = entries.find(entry => entry.plugin.pluginName === 'UNIVER_DRAWING_PLUGIN')
    expect(drawing).toBeDefined()
    drawing?.register(univer)
    expect(injectorOf(univer).get(IImageIoService)).toBe(h.image)
    expect(injectorOf(univer).get(IURLImageService)).toBe(h.url)
  })

  it('URL 和 image IO 两路都经当前原会话读取，不能退回原地址', async () => {
    const h = setup()
    expect(await h.url.getImage(SOURCE)).toBe('blob:https://app.test/first')
    expect(await h.image.getImage(SOURCE)).toBe('blob:https://app.test/first')
    expect(readAsset).toHaveBeenCalledTimes(1)
    expect(vi.mocked(readAsset).mock.calls[0]?.[1]?.session).toBe(h.original)
    expect(h.image.getImageSourceCache(SOURCE, ImageSourceType.URL)?.src).toBe('blob:https://app.test/first')
  })

  it('不能以自定义 URL 下载器替换平台授权读取', () => {
    const h = setup()
    const downloader = vi.fn(async () => 'data:arbitrary')
    expect(() => h.url.registerURLImageDownloader(downloader)).toThrow()
    expect(downloader).not.toHaveBeenCalled()
  })

  it('非平台 URL、UUID 或内嵌源均不发请求，也不作为图片缓存复用', async () => {
    const h = setup()
    for (const source of ['https://evil.test/image.png', 'data:image/png;base64,AA==', UPLOADED.assetId]) {
      expect(await h.url.getImage(source)).not.toBe(source)
      expect(await h.image.getImage(source)).not.toBe(source)
      expect(h.image.getImageSourceCache(source, ImageSourceType.BASE64)).toBeUndefined()
    }
    expect(readAsset).not.toHaveBeenCalled()
  })

  it('读取失败显示本地占位；下载仍拒绝，不交出占位文件', async () => {
    const h = setup()
    vi.mocked(readAsset).mockRejectedValue(new Error('controlled offline'))
    const result = await h.url.getImage(SOURCE)
    expect(result).not.toBe(SOURCE)
    expect(new URL(result).origin).toBe('https://app.test')
    expect(new URL(result).pathname).toMatch(/\.svg$/)
    await expect(h.url.downloadImage(SOURCE)).rejects.toThrow('controlled offline')
    expect(h.failed).toHaveBeenCalledTimes(1)
  })

  it.each([['png', 'image/png'], ['jpg', 'image/jpeg'], ['JPEG', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif']] as const)('上传 %s：规范 source 字段和独立 drawing ID，不复用 assetId', async (extension, mimeType) => {
    const h = setup()
    const file = new File([new Uint8Array([1, 2, 3])], `受控样本.${extension}`, { type: mimeType })
    h.image.setWaitCount(2)
    const one = await h.image.saveImage(file)
    const two = await h.image.saveImage(file)
    expect(one).toMatchObject({ imageSourceType: 'URL', source: SOURCE, base64Cache: SOURCE, status: '0' })
    expect(two?.imageId).not.toBe(one?.imageId)
    expect(one?.imageId).not.toBe(UPLOADED.assetId)
    expect(one?.imageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(vi.mocked(uploadAsset).mock.calls[0]?.[0]).toEqual({ data: new Uint8Array([1, 2, 3]), mimeType, extension: extension.toLowerCase() })
    expect(vi.mocked(uploadAsset).mock.calls[0]?.[1]?.session).toBe(h.original)
  })

  it.each([
    { name: 'wrong.svg', type: 'image/svg+xml', size: 3, status: '2' },
    { name: 'wrong.png', type: 'image/jpeg', size: 3, status: '2' },
    { name: 'no-suffix', type: 'image/png', size: 3, status: '2' },
    { name: 'empty.png', type: 'image/png', size: 0, status: '1' },
    { name: 'large.png', type: 'image/png', size: 5 * 1024 * 1024 + 1, status: '1' },
  ])('$name 在读取文件前拒绝，SDK 进度归零', async ({ name, type, size, status }) => {
    const h = setup()
    const file = new File([new Uint8Array(size)], name, { type })
    const read = vi.spyOn(file, 'arrayBuffer')
    const counts: number[] = []
    const sub = h.image.change$.subscribe(count => counts.push(count))
    h.image.setWaitCount(1)
    await expect(h.image.saveImage(file)).rejects.toThrow(status)
    expect(read).not.toHaveBeenCalled()
    expect(uploadAsset).not.toHaveBeenCalled()
    expect(counts.at(-1)).toBe(0)
    sub.unsubscribe()
  })

  it('5 MiB 文件边界允许上传，读完得到的实际字节由 S1 再核对', async () => {
    const h = setup()
    const file = new File([new Uint8Array(5 * 1024 * 1024)], 'boundary.png', { type: 'image/png' })
    expect(await h.image.saveImage(file)).not.toBeNull()
    expect(vi.mocked(uploadAsset).mock.calls[0]?.[0].data.byteLength).toBe(5 * 1024 * 1024)
  })

  it('只读实例不能通过内部 SDK 服务上传；读取仍可用', async () => {
    const h = setup('read')
    const file = new File([new Uint8Array([1])], 'controlled.png', { type: 'image/png' })
    const read = vi.spyOn(file, 'arrayBuffer')
    expect(await h.image.saveImage(file)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(uploadAsset).not.toHaveBeenCalled()
    expect(await h.url.getImage(SOURCE)).toBe('blob:https://app.test/first')
  })

  it('权限复核先清旧元素，新的读取使用新会话响应对象', async () => {
    const h = setup()
    await h.url.getImage(SOURCE)
    const image = h.image.getImageSourceCache(SOURCE, ImageSourceType.URL)
    const updated = session('new-token')
    h.change(updated)
    expect(image?.src).not.toBe('blob:https://app.test/first')
    await h.url.getImage(SOURCE)
    expect(vi.mocked(readAsset).mock.calls.at(-1)?.[1]?.session).toBe(updated)
  })

  it.each(['suspend', 'other-user', 'dispose'] as const)('%s：旧上传及时返回 null，迟到成功不能恢复图片或污染进度', async (stop) => {
    const h = setup()
    const pending = deferred<AssetUploadResponse>()
    vi.mocked(uploadAsset).mockReturnValueOnce(pending.promise)
    const file = new File([new Uint8Array([1, 2, 3])], 'controlled.png', { type: 'image/png' })
    const counts: number[] = []
    const sub = h.image.change$.subscribe(count => counts.push(count))
    h.image.setWaitCount(1)
    const task = h.image.saveImage(file)
    await vi.waitFor(() => expect(uploadAsset).toHaveBeenCalledTimes(1))
    if (stop === 'dispose')
      h.adapter.dispose()
    else if (stop === 'suspend')
      h.change(undefined)
    else
      h.change({ ...session(), user: { ...session().user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } })
    expect(await task).toBeNull()
    expect(counts.at(-1)).toBe(0)
    pending.resolve(UPLOADED)
    await Promise.resolve()
    await expect(h.url.getImage(SOURCE)).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.failed).not.toHaveBeenCalled()
    sub.unsubscribe()
  })

  it('上传失败有一次错误报告，全部进度结束，不自动重试', async () => {
    const h = setup()
    const file = new File([new Uint8Array([1])], 'controlled.png', { type: 'image/png' })
    vi.mocked(uploadAsset).mockRejectedValueOnce(new Error('controlled failure'))
    const counts: number[] = []
    const sub = h.image.change$.subscribe(count => counts.push(count))
    h.image.setWaitCount(1)
    await expect(h.image.saveImage(file)).rejects.toThrow('4')
    expect(counts.at(-1)).toBe(0)
    expect(uploadAsset).toHaveBeenCalledTimes(1)
    expect(h.failed).toHaveBeenCalledTimes(1)
    sub.unsubscribe()
  })

  it('销毁解绑许可订阅，外部缓存元素立即清除；销毁可重复', async () => {
    const h = setup()
    await h.url.getImage(SOURCE)
    const image = document.createElement('img')
    h.image.addImageSourceCache(SOURCE, ImageSourceType.URL, image)
    expect(image.src).toBe('blob:https://app.test/first')
    h.adapter.dispose()
    h.adapter.dispose()
    expect(image.src).not.toBe('blob:https://app.test/first')
    expect(h.listeners.size).toBe(0)
  })
})
