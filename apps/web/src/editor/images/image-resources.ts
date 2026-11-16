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
  /**
   * 当前文档仍引用的规范相对地址（M5R-M-11）：刷新只清空并重读其中出现过的来源。返回 undefined（还没有文档）时全部重读。
   * 不能用“弱引用还取得到元素”判断在用：core 的 ImageCacheMap（LRU）长期持有已删除图片的元素
   */
  readonly liveSources?: () => ReadonlySet<string> | undefined
}

export interface ImageResources {
  readonly load: (source: string) => Promise<string>
  readonly cached: (source: string) => HTMLImageElement | undefined
  readonly track: (source: string, image: HTMLImageElement) => void
  /**
   * SDK 要再次显示缓存里这个来源的元素（core 补丁在 ImageCacheMap 命中时通知，M5-P9 CX3）：刷新时跳过的已删除来源、静默补读失败的来源，
   * 元素一直是占位；再次显示时补一次正常读取（失败照常报告）。静默补读进行中被再次显示的，那一次读取转为在用（失败照常报告），不另读。
   * 其余来源只做两次集合判断
   */
  readonly revisit: (source: string) => void
  readonly download: (source: string) => Promise<Blob>
  readonly refresh: (retryFailures?: boolean) => void
  readonly suspend: () => void
  readonly dispose: () => void
}

interface Entry {
  readonly images: Set<WeakRef<HTMLImageElement>>
  decoded: DecodedImage | undefined
  task: Promise<string> | undefined
  /** 当前读取是不是静默的；在用的读取加入时改为 false，失败照常报告 */
  attempt: { quiet: boolean } | undefined
  /** 暂停清掉了这一条的像素：恢复时它若已不在文档里，也静默重读一次（S14 审查 E3）；读出或静默失败之后清掉，被取消则留到下次恢复 */
  restore: boolean
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
  /** 暂停期间 SDK 要过不合格的地址：给了占位、SDK 不会再来读，恢复时补报一次（S14 审查 E6） */
  let invalidWhileSuspended = false
  let localFailures = createImageReadFailures()
  const failures = (): ImageReadFailures => options.readFailures?.() ?? localFailures
  /**
   * SDK 还持有元素、但没有像素也没有进行中读取的来源（规范相对地址）：刷新时跳过的已删除来源与静默补读失败的来源。
   * SDK 再次显示它们时（revisit）补读一次（M5-P9 CX3）。暂停、刷新与结束时清空，刷新时按当时的文档重新记下
   */
  const unread = new Set<string>()
  /**
   * 进行中的静默补读（来源 → 那一次读取）。SDK 在读取期间再次显示时（revisit）转为在用：失败照常报告。
   * 失败不改元素的来源，SDK 不会因此重画那一格，等不到下一次命中（M5-P9 独立审查复验）。读取结束、刷新、暂停与结束时移除
   */
  const quietReads = new Map<string, { quiet: boolean }>()

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
      entry = { images: new Set(), decoded: undefined, task: undefined, attempt: undefined, restore: false }
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

  /** SDK 是否还持有这一条的元素（登记过、还没被回收） */
  function held(entry: Entry): boolean {
    let found = false
    forEachImage(entry, () => {
      found = true
    })
    return found
  }

  function clearDecoded(selected: Iterable<Entry> = entries.values()): void {
    for (const entry of selected) {
      entry.decoded?.dispose()
      entry.decoded = undefined
      entry.task = undefined
      entry.attempt = undefined
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

  /** quiet：已删除来源的静默重读（见 refresh）：失败不报告、也不记进本轮失败，之后在用时照常读取和报告 */
  async function load(source: string, quiet = false): Promise<string> {
    if (disposed)
      throw new DOMException('图片实例已结束', 'AbortError')
    // 暂停时显示路径只给本地占位、不读取（M5R-M-09）：抛出取消会让 SDK 不建浮图图元、约每 33 毫秒重试一次。
    // 来源照常登记，SDK 建图元时交回元素登记，恢复时 refresh 重读；地址不合格的失败记下，恢复时补报
    if (!active) {
      const pending = canonical(source)
      if (pending === undefined)
        invalidWhileSuspended = true
      else
        entryOf(pending)
      return options.placeholder
    }
    const signal = generation.signal
    const path = canonical(source)
    if (path === undefined) {
      options.failed(new AssetInputError('address'))
      return options.placeholder
    }
    const entry = entryOf(path)
    const issuedFailures = failures()
    if (issuedFailures.has(path))
      return options.placeholder
    if (entry.task !== undefined) {
      // 在用的读取加入正在进行的静默重读：它失败时照常报告
      if (!quiet && entry.attempt !== undefined)
        entry.attempt.quiet = false
      return entry.task
    }
    const attempt = { quiet }
    if (quiet)
      quietReads.set(path, attempt)
    const settled = (): void => {
      if (quietReads.get(path) === attempt)
        quietReads.delete(path)
    }
    const recordFailure = (error: unknown): void => {
      if (attempt.quiet || disposed || failures() !== issuedFailures || issuedFailures.has(path))
        return
      issuedFailures.add(path)
      options.failed(error)
    }
    const task: Promise<string> = readDecoded(path, signal, (error) => {
      // 只补原请求认证失败的观察；任意取消原因即使形似 ApiError 也不作为新失败。
      if (error instanceof ApiError && error.status === 401
        && (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED')
        && !(signal.aborted && error === signal.reason)) {
        recordFailure(error)
      }
    }).then(({ decoded }) => {
      settled()
      if (signal.aborted) {
        decoded.dispose()
        throw signal.reason
      }
      entry.decoded = decoded
      entry.restore = false
      forEachImage(entry, image => show(image, decoded.url))
      options.changed()
      return decoded.url
    }).catch((error: unknown) => {
      settled()
      if (signal.aborted)
        throw signal.reason
      if (failures() !== issuedFailures)
        return options.placeholder
      if (attempt.quiet) {
        // 静默重读失败：不报告、不再补（restore 清掉），也不留在条目上——之后在用的读取重新读取、照常报告。
        // 单元格图片的“在用”是 SDK 命中缓存里的元素，不会再来 load：记下来源，命中时补读（M5-P9 CX3）
        entry.restore = false
        if (entry.task === task) {
          entry.task = undefined
          entry.attempt = undefined
          if (held(entry))
            unread.add(path)
        }
        return options.placeholder
      }
      recordFailure(error)
      return options.placeholder
    })
    entry.task = task
    entry.attempt = attempt
    return task
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
    revisit: (source) => {
      // 绝大多数命中走这里就返回：每次绘制命中缓存都会调用
      if ((unread.size === 0 && quietReads.size === 0) || disposed || !active)
        return
      const path = canonical(source)
      if (path === undefined)
        return
      const quietRead = quietReads.get(path)
      if (quietRead !== undefined) {
        // 静默补读进行中又被显示：转为在用，失败照常报告（与浮图经 load 合并时相同）；读取照旧，不另读
        quietRead.quiet = false
        quietReads.delete(path)
        return
      }
      if (!unread.delete(path))
        return
      const entry = entries.get(path)
      // 已有像素或读取进行中：load 也会合并或复用那一次读取，这里先返回，不多调用一次
      if (entry === undefined || entry.decoded !== undefined || entry.task !== undefined)
        return
      // 在用的正常读取：失败照常报告（页头据此给出重试），本轮失败过的来源由 load 挡住，不反复读取
      void load(source).catch(() => {})
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
      if (invalidWhileSuspended) {
        invalidWhileSuspended = false
        options.failed(new AssetInputError('address'))
      }
      // 只重读文档里仍引用的来源（M5R-M-11）。已删除的保持现状：不重下、不报告与当前画面无关的失败；
      // 撤销删除时 SDK 缓存里的元素仍显示原来的像素。刷新只发生在同一用户身上（换人一律先暂停、清空）。
      // 例外是暂停清掉了像素、SDK 仍持有元素的已删来源（core 的 ImageCacheMap 命中即复用）：静默重读一次，否则撤销删除时一直是占位、
      // 又没有失败可提示（S14 审查 E3）。只补暂停清掉的那些（restore）、只补一次：从没显示过的或已经补过的，刷新时不重下（S14 复验）。
      // 其余 SDK 仍持有、没有像素的已删来源（第一次读取就失败的）记进 unread：不在刷新时读，SDK 再次显示时补读（M5-P9 CX3）
      const live = options.liveSources?.()
      const selected: [string, Entry][] = []
      const dormant: string[] = []
      unread.clear()
      quietReads.clear()
      for (const [source, entry] of entries) {
        if (live === undefined || live.has(source)) {
          selected.push([source, entry])
        }
        else if (entry.decoded === undefined) {
          entry.task = undefined
          entry.attempt = undefined
          if (!held(entry))
            continue
          if (entry.restore)
            dormant.push(source)
          else
            unread.add(source)
        }
      }
      clearDecoded(selected.map(([, entry]) => entry))
      for (const [source] of selected) {
        // 普通失败已在 load 里报告；下一次刷新/暂停造成的取消没有用户错误。
        void load(source).catch(() => {})
      }
      for (const source of dormant)
        void load(source, true).catch(() => {})
    },
    suspend: () => {
      if (disposed || !active)
        return
      active = false
      generation.abort(new DOMException('图片实例已暂停', 'AbortError'))
      // 记下哪些条目的像素是这次暂停清掉的（之前补到一半又被暂停的，标记留着）；待补读的记录作废，恢复时的刷新按当时的文档重新记
      for (const entry of entries.values())
        entry.restore ||= entry.decoded !== undefined
      unread.clear()
      quietReads.clear()
      clearDecoded()
    },
    dispose: () => {
      if (disposed)
        return
      disposed = true
      active = false
      generation.abort(new DOMException('图片实例已结束', 'AbortError'))
      unread.clear()
      quietReads.clear()
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
