import type { AssetBytes } from '../../shared/assets/asset-api.ts'
import type { ImageReadFailures } from '../../shared/lib/session-image-access.ts'
import type { DecodedImage } from './decode-image.ts'
import { isPlatformAssetAddress } from '@nerve-office/contracts'
import { ApiError } from '../../shared/api/api-errors.ts'
import { AssetInputError } from '../../shared/assets/asset-api.ts'
import { createImageReadFailures } from '../../shared/lib/session-image-access.ts'
import { runImageTask } from './image-task.ts'

export interface ImageResourcesOptions {
  readonly origin: string
  readonly placeholder: string
  /** 显示读取可观察原始拒绝；即使取消先赢，也不改变请求对外结果。下载不注册观察。 */
  readonly read: (source: string, signal: AbortSignal, rejected?: (error: unknown) => void) => Promise<AssetBytes>
  readonly decode: (bytes: AssetBytes, signal: AbortSignal) => Promise<DecodedImage>
  readonly changed: () => void
  readonly failed: (error: unknown) => void
  readonly readFailures?: () => ImageReadFailures
}

export interface ImageResources {
  readonly load: (source: string) => Promise<string>
  readonly cached: (source: string) => HTMLImageElement | undefined
  readonly track: (source: string, image: HTMLImageElement) => void
  readonly download: (source: string) => Promise<Blob>
  readonly refresh: (retryFailures?: boolean) => void
  readonly suspend: () => void
  readonly dispose: () => void
}

interface Entry {
  readonly images: Set<WeakRef<HTMLImageElement>>
  decoded: DecodedImage | undefined
  task: Promise<string> | undefined
}

interface TrackedImage {
  readonly entry: Entry
  readonly reference: WeakRef<HTMLImageElement>
  readonly loaded: () => void
}

export function createImageResources(options: ImageResourcesOptions): ImageResources {
  const entries = new Map<string, Entry>()
  // SDK 已丢弃的元素不被平台缓存再次保活；实例只强持有本代的一份解码原件。
  const tracked = new WeakMap<HTMLImageElement, TrackedImage>()
  let generation = new AbortController()
  let active = true
  let disposed = false
  let localFailures = createImageReadFailures()
  const failures = (): ImageReadFailures => options.readFailures?.() ?? localFailures

  function canonical(source: string): string | undefined {
    if (!isPlatformAssetAddress(source, options.origin))
      return undefined
    return source.startsWith('/') ? source : source.slice(options.origin.length)
  }

  function requireActive(): AbortSignal {
    if (!active || disposed)
      throw new DOMException('图片实例已暂停或结束', 'AbortError')
    return generation.signal
  }

  function entryOf(source: string): Entry {
    let entry = entries.get(source)
    if (entry === undefined) {
      entry = { images: new Set(), decoded: undefined, task: undefined }
      entries.set(source, entry)
    }
    return entry
  }

  function show(image: HTMLImageElement, url: string): void {
    if (image.src !== url)
      image.src = url
  }

  function trackEntry(entry: Entry, image: HTMLImageElement): void {
    const previous = tracked.get(image)
    if (previous?.entry !== entry) {
      if (previous !== undefined) {
        previous.entry.images.delete(previous.reference)
        image.removeEventListener('load', previous.loaded)
      }
      const loaded = (): void => {
        if (!disposed)
          options.changed()
      }
      const reference = new WeakRef(image)
      entry.images.add(reference)
      tracked.set(image, { entry, reference, loaded })
      image.addEventListener('load', loaded)
    }
    show(image, active ? entry.decoded?.url ?? options.placeholder : options.placeholder)
  }

  function forEachImage(entry: Entry, visit: (image: HTMLImageElement) => void): void {
    for (const reference of entry.images) {
      const image = reference.deref()
      if (image === undefined)
        entry.images.delete(reference)
      else
        visit(image)
    }
  }

  function clearDecoded(): void {
    for (const entry of entries.values()) {
      entry.decoded?.dispose()
      entry.decoded = undefined
      entry.task = undefined
      forEachImage(entry, image => show(image, options.placeholder))
    }
    options.changed()
  }

  async function readDecoded(source: string, signal: AbortSignal, rejected?: (error: unknown) => void): Promise<{ bytes: AssetBytes, decoded: DecodedImage }> {
    const bytes = await runImageTask(signal, async () => options.read(source, signal, rejected))
    const decoded = await runImageTask(signal, async () => options.decode(bytes, signal), late => late.dispose())
    try {
      signal.throwIfAborted()
      return { bytes, decoded }
    }
    catch (error) {
      decoded.dispose()
      throw error
    }
  }

  async function load(source: string): Promise<string> {
    const signal = requireActive()
    const path = canonical(source)
    if (path === undefined) {
      options.failed(new AssetInputError('address'))
      return options.placeholder
    }
    const entry = entryOf(path)
    const issuedFailures = failures()
    if (issuedFailures.has(path))
      return options.placeholder
    const recordFailure = (error: unknown): void => {
      if (disposed || failures() !== issuedFailures || issuedFailures.has(path))
        return
      issuedFailures.add(path)
      options.failed(error)
    }
    entry.task ??= readDecoded(path, signal, (error) => {
      // 只补原请求认证失败的观察；任意取消原因即使形似 ApiError 也不作为新失败。
      if (error instanceof ApiError && error.status === 401
        && (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED')
        && !(signal.aborted && error === signal.reason)) {
        recordFailure(error)
      }
    }).then(({ decoded }) => {
      if (signal.aborted) {
        decoded.dispose()
        throw signal.reason
      }
      entry.decoded = decoded
      forEachImage(entry, image => show(image, decoded.url))
      options.changed()
      return decoded.url
    }).catch((error: unknown) => {
      if (signal.aborted)
        throw signal.reason
      if (failures() !== issuedFailures)
        return options.placeholder
      recordFailure(error)
      return options.placeholder
    })
    return entry.task
  }

  return {
    load,
    cached: (source) => {
      const path = canonical(source)
      const entry = active && !disposed && path !== undefined ? entries.get(path) : undefined
      const image = entry?.decoded?.image
      if (entry !== undefined && image !== undefined)
        trackEntry(entry, image)
      return image
    },
    track: (source, image) => {
      const path = canonical(source)
      if (path === undefined || disposed) {
        const previous = tracked.get(image)
        if (previous !== undefined) {
          previous.entry.images.delete(previous.reference)
          image.removeEventListener('load', previous.loaded)
          tracked.delete(image)
        }
        show(image, options.placeholder)
        return
      }
      trackEntry(entryOf(path), image)
    },
    download: async (source) => {
      const signal = requireActive()
      const path = canonical(source)
      if (path === undefined)
        throw new AssetInputError('address')
      const result = await readDecoded(path, signal)
      try {
        signal.throwIfAborted()
        return new Blob([result.bytes.data], { type: result.bytes.mimeType })
      }
      finally {
        result.decoded.dispose()
      }
    },
    refresh: (retryFailures = true) => {
      if (disposed)
        return
      if (retryFailures)
        localFailures = createImageReadFailures()
      generation.abort(new DOMException('图片读取代次已更新', 'AbortError'))
      generation = new AbortController()
      active = true
      clearDecoded()
      for (const source of entries.keys()) {
        // 普通失败已在 load 里报告；下一次刷新/暂停造成的取消没有用户错误。
        void load(source).catch(() => {})
      }
    },
    suspend: () => {
      if (disposed || !active)
        return
      active = false
      generation.abort(new DOMException('图片实例已暂停', 'AbortError'))
      clearDecoded()
    },
    dispose: () => {
      if (disposed)
        return
      disposed = true
      active = false
      generation.abort(new DOMException('图片实例已结束', 'AbortError'))
      clearDecoded()
      for (const entry of entries.values()) {
        forEachImage(entry, (image) => {
          const previous = tracked.get(image)
          if (previous !== undefined)
            image.removeEventListener('load', previous.loaded)
          tracked.delete(image)
        })
      }
      entries.clear()
    },
  }
}
