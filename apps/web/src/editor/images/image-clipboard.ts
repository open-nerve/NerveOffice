import type { AssetBytes } from '../../shared/assets/asset-api.ts'
import { ASSET_MAX_BYTES } from '@nerve-office/contracts'
import { decodeImage } from './decode-image.ts'
import { runImageTask } from './image-task.ts'

export type ImageClipboardReader = (source: string, signal: AbortSignal) => Promise<AssetBytes>

export class ImageClipboardError extends Error {
  override readonly name = 'ImageClipboardError'
  readonly reason: 'unsupported' | 'encoding' | 'size' | 'timeout' | 'empty'
  constructor(reason: ImageClipboardError['reason']) {
    super('系统图片操作未完成')
    this.reason = reason
  }
}

async function imagePng(source: string, signal: AbortSignal, read: ImageClipboardReader): Promise<Blob> {
  const bytes = await runImageTask(signal, async () => read(source, signal))
  const decoded = await runImageTask(signal, async () => decodeImage(bytes, signal), late => late.dispose())
  let canvas: HTMLCanvasElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    if (bytes.mimeType === 'image/png')
      return new Blob([bytes.data], { type: 'image/png' })
    const controller = new AbortController()
    const encodingSignal = AbortSignal.any([signal, controller.signal])
    timer = setTimeout(() => controller.abort(new ImageClipboardError('timeout')), 10_000)
    canvas = document.createElement('canvas')
    canvas.width = decoded.image.naturalWidth
    canvas.height = decoded.image.naturalHeight
    const context = canvas.getContext('2d')
    if (context === null)
      throw new ImageClipboardError('encoding')
    context.drawImage(decoded.image, 0, 0)
    const output = canvas
    const blob = await runImageTask(encodingSignal, async () => new Promise<Blob>((resolve, reject) => {
      output.toBlob((value) => {
        if (value === null || value.type !== 'image/png')
          reject(new ImageClipboardError('encoding'))
        else
          resolve(value)
      }, 'image/png')
    }))
    if (blob.size < 1 || blob.size > ASSET_MAX_BYTES)
      throw new ImageClipboardError('size')
    return blob
  }
  finally {
    clearTimeout(timer)
    decoded.dispose()
    if (canvas !== undefined) {
      canvas.width = 0
      canvas.height = 0
    }
  }
}

/** 第一个 await 之前调用系统 write；ClipboardItem 持有稍后完成的 PNG Promise。 */
export async function writeSystemImage(source: string, signal: AbortSignal, read: ImageClipboardReader): Promise<void> {
  signal.throwIfAborted()
  const clipboard = navigator.clipboard
  if (typeof ClipboardItem === 'undefined' || typeof clipboard?.write !== 'function')
    throw new ImageClipboardError('unsupported')
  const controller = new AbortController()
  const operation = AbortSignal.any([signal, controller.signal])
  const png = imagePng(source, operation, read)
  const writing = runImageTask(operation, async () => clipboard.write([new ClipboardItem({ 'image/png': png })]))
  try {
    await Promise.all([writing, png])
  }
  finally {
    // write 可在读取/编码结束前拒绝；终止其余工作并消费迟到结果，不再写任何兜底内容。
    controller.abort(new DOMException('图片复制已结束', 'AbortError'))
  }
}
