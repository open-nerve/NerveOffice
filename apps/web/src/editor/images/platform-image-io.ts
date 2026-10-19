import type { AssetUploadResponse, SessionResponse } from '@nerve-office/contracts'
import type { AssetBytes } from '../../shared/assets/asset-api.ts'
import type { EditorAccess } from '../editor-access.ts'
import type { IImageIoService, IURLImageService } from '../internal-api/ui.ts'
import { isPlatformAssetAddress } from '@nerve-office/contracts'
import { Subject } from 'rxjs'
import { AssetInputError, readAsset, uploadAsset } from '../../shared/assets/asset-api.ts'
import { imageServiceOverride, ImageSourceType, ImageUploadStatusType } from '../internal-api/ui.ts'
import { decodeImage } from './decode-image.ts'
import { imageFileInput, ImageFileInputError } from './image-input-policy.ts'
import { createImageResources } from './image-resources.ts'
import { runImageTask } from './image-task.ts'
import unavailable from './unavailable.svg?url&no-inline'

export interface EditorImageAccess {
  /** 创建时已经确认的页面所有者；许可暂停时仍保留，不能由后来的用户认领实例。 */
  readonly owner?: string
  readonly current: () => SessionResponse | undefined
  readonly subscribe: (listener: () => void) => () => void
}

export interface PlatformImageIoOptions {
  readonly access: EditorAccess
  readonly identity: EditorImageAccess
  readonly origin: string
  readonly changed: () => void
  readonly invalidated?: () => void
  readonly failed: (error: unknown) => void
}

export interface PlatformImageIo {
  readonly override: ReturnType<typeof imageServiceOverride>
  readonly upload: (file: File, signal: AbortSignal) => Promise<AssetUploadResponse>
  readonly read: (source: string, signal: AbortSignal) => Promise<AssetBytes>
  readonly dispose: () => void
}

export function createPlatformImageIo(options: PlatformImageIoOptions): PlatformImageIo {
  const owner = options.identity.owner ?? options.identity.current()?.user.id
  const progress = new Subject<number>()
  let disposed = false
  let uploads = new AbortController()
  let waiting = 0

  function session(): SessionResponse | undefined {
    const current = options.identity.current()
    return !disposed && owner !== undefined && current?.user.id === owner ? current : undefined
  }

  async function read(source: string, caller: AbortSignal): Promise<AssetBytes> {
    const original = session()
    if (original === undefined)
      throw new DOMException('图片身份已失效', 'AbortError')
    const signal = AbortSignal.any([uploads.signal, caller])
    signal.throwIfAborted()
    if (!isPlatformAssetAddress(source, options.origin))
      throw new AssetInputError('address')
    const path = source.startsWith('/') ? source : source.slice(options.origin.length)
    return runImageTask(signal, async () => readAsset(path, { signal, session: original }))
  }

  async function upload(file: File, caller: AbortSignal): Promise<AssetUploadResponse> {
    const original = session()
    if (options.access !== 'edit' || original === undefined)
      throw new DOMException('图片写入许可已失效', 'AbortError')
    const signal = AbortSignal.any([uploads.signal, caller])
    signal.throwIfAborted()
    const input = imageFileInput(file)
    const buffer = await runImageTask(signal, async () => file.arrayBuffer())
    return runImageTask(signal, async () => uploadAsset({ ...input, data: new Uint8Array(buffer) }, { signal, session: original }))
  }

  const resources = createImageResources({
    origin: options.origin,
    placeholder: new URL(unavailable, options.origin).href,
    read,
    decode: decodeImage,
    changed: options.changed,
    failed: options.failed,
  })
  if (session() === undefined)
    resources.suspend()

  function setWaiting(count: number): void {
    waiting = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
    progress.next(waiting)
  }

  const unsubscribe = options.identity.subscribe(() => {
    if (disposed)
      return
    options.invalidated?.()
    uploads.abort(new DOMException('图片上传代次已更新', 'AbortError'))
    uploads = new AbortController()
    setWaiting(0)
    if (session() === undefined)
      resources.suspend()
    else
      resources.refresh()
  })

  const images: IImageIoService = {
    change$: progress.asObservable(),
    setWaitCount: (count) => {
      if (!disposed)
        setWaiting(count)
    },
    getImage: resources.load,
    getImageSourceCache: (source, type) => type === ImageSourceType.BASE64 ? undefined : resources.cached(source),
    addImageSourceCache: (source, type, image) => {
      if (image !== null && image !== undefined)
        resources.track(type === ImageSourceType.BASE64 ? '' : source, image)
    },
    saveImage: async (file) => {
      const controller = uploads
      try {
        if (options.access !== 'edit' || session() === undefined)
          return null
        const uploaded = await upload(file, controller.signal)
        controller.signal.throwIfAborted()
        if (disposed || session() === undefined)
          return null
        return {
          imageId: crypto.randomUUID(),
          imageSourceType: ImageSourceType.URL,
          source: uploaded.url,
          base64Cache: uploaded.url,
          status: ImageUploadStatusType.SUCCUSS,
        }
      }
      catch (error) {
        if (controller.signal.aborted || disposed)
          return null
        if (error instanceof ImageFileInputError)
          throw new Error(error.reason === 'size' ? ImageUploadStatusType.ERROR_EXCEED_SIZE : ImageUploadStatusType.ERROR_IMAGE_TYPE)
        options.failed(error)
        throw new Error(ImageUploadStatusType.ERROR_IMAGE)
      }
      finally {
        if (controller === uploads && !disposed)
          setWaiting(waiting - 1)
      }
    },
  }
  const urls: IURLImageService = {
    getImage: resources.load,
    downloadImage: resources.download,
    registerURLImageDownloader: () => {
      throw new Error('图片读取由平台统一处理')
    },
  }
  return {
    override: imageServiceOverride(images, urls),
    upload,
    read,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      unsubscribe()
      options.invalidated?.()
      uploads.abort(new DOMException('图片实例已结束', 'AbortError'))
      setWaiting(0)
      progress.complete()
      resources.dispose()
    },
  }
}
