import type { AssetUploadResponse, SessionResponse } from '@nerve-office/contracts'
import type { EditorAccess } from '../editor-access.ts'
import type { EditorImageAccess } from './platform-image-io.ts'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { ImageCacheMap, Univer } from '@univerjs/core'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/api-errors.ts'
import { readAsset, uploadAsset } from '../../shared/assets/asset-api.ts'
import { createSessionImageAccess } from '../../shared/lib/session-image-access.ts'
import { deferred } from '../async-tools.ts'
import { injectorOf } from '../internal-api/index.ts'
import { IImageIoService, ImageSourceType, IURLImageService } from '../internal-api/ui.ts'
import { sheetPluginEntries } from '../profile/sheet-profile.ts'
import { decodeImage } from './decode-image.ts'
import { BYTES, decoded, OTHER, SOURCE } from './image-resources.test-support.ts'
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

function setup(access: EditorAccess = 'edit', initial: SessionResponse | null = session(), owner?: string, identity?: EditorImageAccess, liveSources?: () => ReadonlySet<string>) {
  let current: SessionResponse | undefined = initial ?? undefined
  const listeners = new Set<() => void>()
  const failed = vi.fn()
  const invalidated = vi.fn()
  const changed = vi.fn()
  const adapter = createPlatformImageIo({
    access,
    identity: identity ?? {
      ...(owner === undefined ? {} : { owner }),
      current: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    origin: 'https://app.test',
    changed,
    failed,
    invalidated,
    ...(liveSources === undefined ? {} : { liveSources }),
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
    changed,
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
  vi.mocked(readAsset).mockReset().mockResolvedValue(BYTES)
  vi.mocked(uploadAsset).mockReset().mockResolvedValue(UPLOADED)
  vi.mocked(decodeImage).mockReset().mockImplementation(async () => decoded())
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
    // 暂停时显示路径给本地占位、不读取（M5R-M-09）；下载仍拒绝
    expect(new URL(await h.url.getImage(SOURCE)).pathname).toMatch(/\.svg$/)
    h.change({ ...original, user: { ...original.user, id: 'other-user' } })
    expect(new URL(await h.url.getImage(SOURCE)).pathname).toMatch(/\.svg$/)
    expect(readAsset).not.toHaveBeenCalled()
    h.change(original)
    await expect(h.url.getImage(SOURCE)).resolves.toBe('blob:https://app.test/first')
    expect(vi.mocked(readAsset).mock.calls.at(-1)?.[1]?.session).toBe(original)
  })

  it('未提供所有者也没有初始身份时永久关闭，不能由后来第一个人认领', async () => {
    const h = setup('read', null)
    h.change(session())
    expect(new URL(await h.url.getImage(SOURCE)).pathname).toMatch(/\.svg$/)
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

/** 等一个宏任务：替身读取与解码都是立即完成的 Promise，一轮足够落定 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

// M5-P9 CX3（Codex 合并后评审）：清除与撤销复用同一个工作表骨架，core 的 ImageCacheMap 命中直接返回缓存里的元素，
// 只有未命中才登记并读取。刷新跳过已删除、没有像素的来源之后，撤销时的绘制必须经命中通知补读一次，否则一直是占位、也没有失败提示
describe('SDK 缓存命中时补读刷新跳过的来源（M5-P9 CX3）', () => {
  /** 单元格图片第一次读取失败、清空该格、恢复联网刷新：返回 SDK 缓存里的占位元素与文档引用的切换 */
  async function failedThenRemoved() {
    let live: ReadonlySet<string> = new Set([SOURCE])
    const h = setup('edit', session(), undefined, undefined, () => live)
    vi.mocked(readAsset).mockRejectedValueOnce(new NetworkError('首次读取断网'))
    const cache = new ImageCacheMap(h.injector)
    expect(cache.getImage(ImageSourceType.URL, SOURCE)).toBeNull()
    await vi.waitFor(() => expect(h.failed).toHaveBeenCalledOnce())
    const image = cache.getImage(ImageSourceType.URL, SOURCE)
    if (image === null)
      throw new Error('SDK 缓存里没有登记的元素')
    expect(image.src).not.toBe('blob:https://app.test/first')
    live = new Set()
    // 恢复联网：页面经图片许可通知刷新；已删除、没有像素的来源不读取（M5R-M-11）
    h.change(session())
    await settle()
    expect(readAsset).toHaveBeenCalledOnce()
    const restore = (): void => {
      live = new Set([SOURCE])
    }
    return { h, cache, image, restore }
  }

  it('撤销之后 SDK 命中缓存：补读一次，同一元素换上像素，之后的命中不再读取', async () => {
    const { h, cache, image, restore } = await failedThenRemoved()
    restore()
    expect(cache.getImage(ImageSourceType.URL, SOURCE)).toBe(image)
    await vi.waitFor(() => expect(image.src).toBe('blob:https://app.test/first'))
    expect(readAsset).toHaveBeenCalledTimes(2)
    cache.getImage(ImageSourceType.URL, SOURCE)
    await settle()
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(h.failed).toHaveBeenCalledOnce()
  })

  it('补读仍失败照常报告（页头据此给出重试），同一轮不反复读取', async () => {
    const { h, cache, image, restore } = await failedThenRemoved()
    restore()
    const error = new NetworkError('补读也断网')
    vi.mocked(readAsset).mockRejectedValueOnce(error)
    cache.getImage(ImageSourceType.URL, SOURCE)
    await vi.waitFor(() => expect(h.failed).toHaveBeenCalledTimes(2))
    expect(h.failed).toHaveBeenLastCalledWith(error)
    expect(image.src).not.toBe('blob:https://app.test/first')
    cache.getImage(ImageSourceType.URL, SOURCE)
    await settle()
    expect(readAsset).toHaveBeenCalledTimes(2)
  })

  it('已显示的图片删除、暂停清掉像素、恢复时静默补读失败：撤销之后的命中照常读取', async () => {
    let live: ReadonlySet<string> = new Set([SOURCE])
    const h = setup('edit', session(), undefined, undefined, () => live)
    const cache = new ImageCacheMap(h.injector)
    cache.getImage(ImageSourceType.URL, SOURCE)
    await settle()
    const image = cache.getImage(ImageSourceType.URL, SOURCE)
    if (image === null)
      throw new Error('SDK 缓存里没有登记的元素')
    expect(image.src).toBe('blob:https://app.test/first')
    live = new Set()
    h.change(undefined)
    expect(image.src).not.toBe('blob:https://app.test/first')
    vi.mocked(readAsset).mockRejectedValueOnce(new NetworkError('静默补读断网'))
    h.change(session())
    await vi.waitFor(() => expect(readAsset).toHaveBeenCalledTimes(2))
    await settle()
    expect(h.failed).not.toHaveBeenCalled()
    live = new Set([SOURCE])
    expect(cache.getImage(ImageSourceType.URL, SOURCE)).toBe(image)
    await vi.waitFor(() => expect(image.src).toBe('blob:https://app.test/first'))
    expect(readAsset).toHaveBeenCalledTimes(3)
  })

  it('暂停时命中不读取；恢复后来源回到文档里、刷新照常重读，读取进行中与读完之后的命中都不另读', async () => {
    const { h, cache, image, restore } = await failedThenRemoved()
    h.change(undefined)
    cache.getImage(ImageSourceType.URL, SOURCE)
    await settle()
    expect(readAsset).toHaveBeenCalledOnce()
    const pending = deferred<typeof BYTES>()
    vi.mocked(readAsset).mockReturnValueOnce(pending.promise)
    restore()
    // 本人回来：来源已回到文档里，刷新照常重读它；这次读取进行中的命中不另读
    h.change(session())
    await vi.waitFor(() => expect(readAsset).toHaveBeenCalledTimes(2))
    cache.getImage(ImageSourceType.URL, SOURCE)
    pending.resolve(BYTES)
    await vi.waitFor(() => expect(image.src).toBe('blob:https://app.test/first'))
    cache.getImage(ImageSourceType.URL, SOURCE)
    await settle()
    expect(readAsset).toHaveBeenCalledTimes(2)
  })

  // 独立审查 M-3：来源已记进待补读，又经 IURLImageService（浮图的同一地址）读取；撤销时的命中只合并或复用那一次读取
  it('待补读的来源正经别的路径读取：撤销时的命中合并那一次读取，不另读', async () => {
    const { h, cache, image, restore } = await failedThenRemoved()
    const pending = deferred<typeof BYTES>()
    vi.mocked(readAsset).mockReturnValueOnce(pending.promise)
    const floating = h.url.getImage(SOURCE)
    await vi.waitFor(() => expect(readAsset).toHaveBeenCalledTimes(2))
    restore()
    expect(cache.getImage(ImageSourceType.URL, SOURCE)).toBe(image)
    await settle()
    expect(readAsset).toHaveBeenCalledTimes(2)
    pending.resolve(BYTES)
    await expect(floating).resolves.toBe('blob:https://app.test/first')
    await vi.waitFor(() => expect(image.src).toBe('blob:https://app.test/first'))
    expect(readAsset).toHaveBeenCalledTimes(2)
  })

  it('待补读的来源已经别的路径读到像素：撤销时的命中直接复用，不另读', async () => {
    const { h, cache, image, restore } = await failedThenRemoved()
    await expect(h.url.getImage(SOURCE)).resolves.toBe('blob:https://app.test/first')
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(image.src).toBe('blob:https://app.test/first')
    restore()
    expect(cache.getImage(ImageSourceType.URL, SOURCE)).toBe(image)
    await settle()
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(h.failed).toHaveBeenCalledOnce()
  })

  it('恢复时的静默补读进行中撤销（这次命中落在读取期间）：这次读取转为在用，随后失败照常报告，不另读', async () => {
    // 独立审查与复验：命中发生在静默补读期间，来源那时还不在待补读里。失败不改元素的来源，SDK 不会因此重画这一格，
    // 等不到下一次命中；所以在命中当时把这次读取转为在用，失败照常报告、页头给出重试（与浮图经 load 合并时相同）
    let live: ReadonlySet<string> = new Set([SOURCE])
    const h = setup('edit', session(), undefined, undefined, () => live)
    const cache = new ImageCacheMap(h.injector)
    cache.getImage(ImageSourceType.URL, SOURCE)
    await settle()
    const image = cache.getImage(ImageSourceType.URL, SOURCE)
    if (image === null)
      throw new Error('SDK 缓存里没有登记的元素')
    expect(image.src).toBe('blob:https://app.test/first')
    live = new Set()
    h.change(undefined)
    const quiet = deferred<typeof BYTES>()
    vi.mocked(readAsset).mockReturnValueOnce(quiet.promise)
    h.change(session())
    await vi.waitFor(() => expect(readAsset).toHaveBeenCalledTimes(2))
    live = new Set([SOURCE])
    expect(cache.getImage(ImageSourceType.URL, SOURCE)).toBe(image)
    const error = new NetworkError('静默补读断网')
    quiet.reject(error)
    await vi.waitFor(() => expect(h.failed).toHaveBeenCalledOnce())
    expect(h.failed).toHaveBeenCalledWith(error)
    expect(image.src).not.toBe('blob:https://app.test/first')
    cache.getImage(ImageSourceType.URL, SOURCE)
    await settle()
    expect(readAsset).toHaveBeenCalledTimes(2)
  })
})

afterEach(() => {
  for (const finish of cleanup.splice(0))
    finish()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('真实 drawing 插件中的平台 IO', () => {
  it('系统输入上传返回服务端尺寸，和 SDK 上传共用会话及元信息检查', async () => {
    const h = setup()
    const file = new File([new Uint8Array([1, 2, 3])], 'controlled.png', { type: 'image/png' })
    expect(await h.adapter.upload(file, new AbortController().signal)).toEqual(UPLOADED)
    expect(vi.mocked(uploadAsset).mock.calls[0]?.[1]?.session).toBe(h.original)
    expect(h.failed).not.toHaveBeenCalled()
  })

  it('系统操作失败交回调用方，不误报图片加载失败', async () => {
    const h = setup()
    const error = new Error('controlled failure')
    vi.mocked(uploadAsset).mockRejectedValueOnce(error)
    const file = new File([new Uint8Array([1])], 'controlled.png', { type: 'image/png' })
    await expect(h.adapter.upload(file, new AbortController().signal)).rejects.toBe(error)
    const read = vi.spyOn(file, 'arrayBuffer')
    h.change(undefined)
    await expect(h.adapter.upload(file, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
    expect(h.failed).not.toHaveBeenCalled()
  })

  it.each(['caller', 'identity', 'dispose'] as const)('%s 取消系统上传并取消底层请求，重试仍可使用新代次', async (stop) => {
    const h = setup()
    const pending = deferred<AssetUploadResponse>()
    vi.mocked(uploadAsset).mockReturnValueOnce(pending.promise)
    const controller = new AbortController()
    const file = new File([new Uint8Array([1])], 'controlled.png', { type: 'image/png' })
    const result = h.adapter.upload(file, controller.signal)
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(uploadAsset).toHaveBeenCalledOnce())
    const requestSignal = vi.mocked(uploadAsset).mock.calls[0]?.[1]?.signal
    if (stop === 'caller')
      controller.abort()
    else if (stop === 'identity')
      h.change(session('renewed'))
    else
      h.adapter.dispose()
    await assertion
    expect(requestSignal?.aborted).toBe(true)
    pending.resolve(UPLOADED)
    if (stop !== 'dispose')
      expect(await h.adapter.upload(file, new AbortController().signal)).toEqual(UPLOADED)
    expect(h.failed).not.toHaveBeenCalled()
  })

  it('系统复制每次重新鉴权读取原字节；调用方取消不退役显示缓存', async () => {
    const h = setup('read')
    await h.url.getImage(SOURCE)
    expect(await h.adapter.read(SOURCE, new AbortController().signal)).toEqual(BYTES)
    expect(readAsset).toHaveBeenCalledTimes(2)
    const pending = deferred<typeof BYTES>()
    vi.mocked(readAsset).mockReturnValueOnce(pending.promise)
    const controller = new AbortController()
    const result = h.adapter.read(SOURCE, controller.signal)
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
    expect(vi.mocked(readAsset).mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true)
    expect(h.image.getImageSourceCache(SOURCE, ImageSourceType.URL)?.src).toBe('blob:https://app.test/first')
    pending.resolve(BYTES)
    expect(h.failed).not.toHaveBeenCalled()
  })

  it('系统读取在无效来源、身份或预取消时不发请求；只读不能上传', async () => {
    const h = setup('read')
    const signal = new AbortController().signal
    await expect(h.adapter.read('https://outside.invalid/image.png', signal)).rejects.toMatchObject({ reason: 'address' })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(h.adapter.read(SOURCE, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const file = new File([new Uint8Array([1])], 'controlled.png', { type: 'image/png' })
    const read = vi.spyOn(file, 'arrayBuffer')
    await expect(h.adapter.upload(file, signal)).rejects.toMatchObject({ name: 'AbortError' })
    h.change(undefined)
    await expect(h.adapter.read(SOURCE, signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
    expect(readAsset).not.toHaveBeenCalled()
    expect(uploadAsset).not.toHaveBeenCalled()
  })

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

  it('图片 401 先停写后确认：同身份恢复可上传，但失败缓存等待明确重试才重读', async () => {
    const h = setup()
    const error = new ApiError(401, 'UNAUTHENTICATED', '图片不可读')
    vi.mocked(readAsset).mockRejectedValueOnce(error)
    const placeholder = await h.url.getImage(SOURCE)
    expect(new URL(placeholder).pathname).toMatch(/\.svg$/)
    expect(h.failed).toHaveBeenCalledExactlyOnceWith(error)
    expect(readAsset).toHaveBeenCalledOnce()
    h.change(undefined)
    expect(new URL(await h.url.getImage(SOURCE)).pathname).toMatch(/\.svg$/)
    const confirmed = { ...h.original! }
    h.change(confirmed)
    // 沿真实资源表读同一失败源，不能因暂停/恢复抹掉失败并发出第二次请求。
    expect.soft(await h.url.getImage(SOURCE)).toBe(placeholder)
    expect.soft(readAsset).toHaveBeenCalledOnce()
    const file = new File([new Uint8Array([1, 2, 3])], 'controlled.png', { type: 'image/png' })
    expect(await h.adapter.upload(file, new AbortController().signal)).toEqual(UPLOADED)
    expect(vi.mocked(uploadAsset).mock.calls[0]?.[1]?.session).toBe(confirmed)
    // 已活跃时的明确刷新仍打开一轮新读取，不能把失败做成永久禁用。
    h.change(confirmed)
    expect(await h.url.getImage(SOURCE)).toBe('blob:https://app.test/first')
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(h.failed).toHaveBeenCalledOnce()
  })

  it.each(['before-confirm', 'after-confirm'] as const)('停写 %s：页面失败来源跨只读/编辑实例重建保留，新上传与新来源不被旧失败阻止', async (order) => {
    const original = session()
    const identity = createSessionImageAccess(original.user.id, { preserveReadFailures: true })
    identity.confirm(original)
    const reader = setup('read', original, undefined, identity)
    vi.mocked(readAsset).mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', '图片不可读'))
    const placeholder = await reader.url.getImage(SOURCE)
    if (order === 'after-confirm')
      identity.confirm({ ...original })
    identity.suspend()
    const confirmed = { ...original }
    identity.confirm(confirmed)
    reader.adapter.dispose()
    const editor = setup('edit', confirmed, undefined, identity)
    expect(await editor.url.getImage(`https://app.test${SOURCE}`)).toBe(placeholder)
    expect(readAsset).toHaveBeenCalledOnce()
    const file = new File([new Uint8Array([1])], 'controlled.png', { type: 'image/png' })
    vi.mocked(uploadAsset).mockResolvedValueOnce({ ...UPLOADED, url: OTHER })
    expect(await editor.adapter.upload(file, new AbortController().signal)).toMatchObject({ url: OTHER })
    expect(vi.mocked(uploadAsset).mock.calls[0]?.[1]?.session).toBe(confirmed)
    expect(await editor.url.getImage(OTHER)).toBe('blob:https://app.test/first')
    expect(readAsset).toHaveBeenCalledTimes(2)
    identity.refresh()
    expect(await editor.url.getImage(SOURCE)).toBe('blob:https://app.test/first')
    expect(identity.readFailures().has(SOURCE)).toBe(false)
    expect(editor.failed).not.toHaveBeenCalled()
  })

  it.each(['csrf', 'refresh', 'other-user', 'dispose'] as const)('读取中的旧 401 晚于 %s：不锁存到新读取轮次，不清新像素', async (change) => {
    const original = session()
    const identity = createSessionImageAccess(original.user.id, { preserveReadFailures: true })
    identity.confirm(original)
    const h = setup('edit', original, undefined, identity)
    const pending = deferred<typeof BYTES>()
    vi.mocked(readAsset).mockReturnValueOnce(pending.promise)
    const old = h.url.getImage(SOURCE).catch((error: unknown) => error)
    await vi.waitFor(() => expect(readAsset).toHaveBeenCalledOnce())
    if (change === 'csrf') {
      identity.confirm(session('new-token'))
    }
    else if (change === 'refresh') {
      identity.refresh()
    }
    else if (change === 'other-user') {
      identity.confirm({ ...original, user: { ...original.user, id: 'other-user' } })
      expect(identity.current()).toBeUndefined()
      identity.confirm(original)
    }
    else {
      identity.dispose()
    }
    expect(await old).toMatchObject({ name: 'AbortError' })
    pending.reject(new ApiError(401, 'UNAUTHENTICATED', '旧读取晚失败'))
    await Promise.resolve()
    await Promise.resolve()
    expect(identity.readFailures().has(SOURCE)).toBe(false)
    expect(h.failed).not.toHaveBeenCalled()
    if (change === 'dispose')
      expect(new URL(await h.url.getImage(SOURCE)).pathname).toMatch(/\.svg$/)
    else
      expect(await h.url.getImage(SOURCE)).toBe('blob:https://app.test/first')
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
    // 实例已结束仍拒绝；暂停与换人时显示路径给本地占位（M5R-M-09）
    if (stop === 'dispose')
      await expect(h.url.getImage(SOURCE)).rejects.toMatchObject({ name: 'AbortError' })
    else
      expect(new URL(await h.url.getImage(SOURCE)).pathname).toMatch(/\.svg$/)
    expect(h.failed).not.toHaveBeenCalled()
    sub.unsubscribe()
  })

  it.each([
    { error: new ApiError(413, 'PAYLOAD_TOO_LARGE', 'controlled-private-marker'), status: '1' },
    { error: new ApiError(413, 'UNKNOWN', 'controlled-private-marker'), status: '1' },
    { error: new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'controlled-private-marker'), status: '2' },
    { error: new ApiError(422, 'ASSET_INVALID', 'controlled-private-marker'), status: '4' },
    { error: new ApiError(409, 'ASSET_QUOTA_EXCEEDED', 'controlled-private-marker'), status: '4' },
    { error: new ApiError(503, 'ASSET_BUSY', 'controlled-private-marker'), status: '4' },
    { error: new NetworkError('controlled-private-marker'), status: '4' },
  ])('服务端上传失败交给 SDK 固定状态 $status，保留一次原错误报告并归零进度', async ({ error, status }) => {
    const h = setup()
    const file = new File([new Uint8Array([1])], 'controlled.png', { type: 'image/png' })
    vi.mocked(uploadAsset).mockRejectedValueOnce(error)
    const counts: number[] = []
    const sub = h.image.change$.subscribe(count => counts.push(count))
    h.image.setWaitCount(1)
    await expect(h.image.saveImage(file)).rejects.toMatchObject({ message: status })
    expect(counts.at(-1)).toBe(0)
    expect(uploadAsset).toHaveBeenCalledOnce()
    expect(h.failed).toHaveBeenCalledExactlyOnceWith(error)
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
