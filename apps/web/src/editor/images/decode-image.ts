import type { AssetBytes } from '../../shared/assets/asset-api.ts'
import { ASSET_MAX_BYTES, ASSET_MAX_PIXELS, ASSET_MAX_SIDE } from '@nerve-office/contracts'
import { runImageTask } from './image-task.ts'

export const IMAGE_DECODE_TIMEOUT_MS = 10_000

export interface DecodedImage {
  readonly url: string
  readonly image: HTMLImageElement
  readonly dispose: () => void
}

export class ImageDecodeError extends Error {
  override readonly name = 'ImageDecodeError'
  readonly reason: 'invalid' | 'dimensions' | 'timeout'

  constructor(reason: 'invalid' | 'dimensions' | 'timeout') {
    super('图片无法显示')
    this.reason = reason
  }
}

export async function decodeImage(bytes: AssetBytes, signal: AbortSignal): Promise<DecodedImage> {
  signal.throwIfAborted()
  if (bytes.data.byteLength < 1 || bytes.data.byteLength > ASSET_MAX_BYTES)
    throw new ImageDecodeError('invalid')
  const controller = new AbortController()
  let image: HTMLImageElement | undefined
  let url: string | undefined
  let released = false
  const dispose = (): void => {
    if (released)
      return
    released = true
    image?.removeAttribute('src')
    if (url !== undefined)
      URL.revokeObjectURL(url)
  }
  const cancel = (reason: unknown): void => {
    dispose()
    controller.abort(reason)
  }
  const forwardAbort = (): void => cancel(signal.reason)
  signal.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => cancel(new ImageDecodeError('timeout')), IMAGE_DECODE_TIMEOUT_MS)
  try {
    image = new Image()
    url = URL.createObjectURL(new Blob([bytes.data], { type: bytes.mimeType }))
    image.src = url
    const decoding = image
    await runImageTask(controller.signal, async () => decoding.decode())
    controller.signal.throwIfAborted()
    if (!image.complete)
      throw new ImageDecodeError('invalid')
    const { naturalWidth: width, naturalHeight: height } = image
    if (width < 1 || height < 1 || width > ASSET_MAX_SIDE || height > ASSET_MAX_SIDE || width * height > ASSET_MAX_PIXELS)
      throw new ImageDecodeError('dimensions')
    return { url, image, dispose }
  }
  catch (error) {
    dispose()
    if (controller.signal.aborted)
      throw controller.signal.reason
    throw error instanceof ImageDecodeError ? error : new ImageDecodeError('invalid')
  }
  finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', forwardAbort)
  }
}
