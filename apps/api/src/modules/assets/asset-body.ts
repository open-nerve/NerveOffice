import type { AssetExtension, AssetMimeType } from '@nerve-office/contracts'
import type { Request } from 'express'
import type { ImageProcessingInput } from './image-types.ts'
import { Buffer } from 'node:buffer'
import { ASSET_EXTENSIONS, ASSET_MIME_TYPES } from '@nerve-office/contracts'
import { AppError } from '../../shared/errors/app-error.ts'
import { imageAborted } from './image-admission.ts'
import { IMAGE_LIMITS } from './image-types.ts'

/** 提前拒绝不继续读取/排空任意长的正文，回包后关闭这条连接。 */
function refuse(code: 'UNSUPPORTED_MEDIA_TYPE' | 'REQUEST_INVALID' | 'PAYLOAD_TOO_LARGE'): AppError {
  return new AppError(code, undefined, { headers: { Connection: 'close' } })
}

export async function readAssetBody(request: Request, signal: AbortSignal): Promise<ImageProcessingInput> {
  const mimeType = request.headers['content-type']?.toLowerCase()
  const encoding = request.headers['content-encoding']?.toLowerCase()
  if (!(ASSET_MIME_TYPES as readonly unknown[]).includes(mimeType) || (encoding !== undefined && encoding !== 'identity'))
    throw refuse('UNSUPPORTED_MEDIA_TYPE')
  const rawExtension = request.headers['x-asset-extension']
  const extension = typeof rawExtension === 'string' && /^[A-Z]+$/i.test(rawExtension) ? rawExtension.toLowerCase() : undefined
  if (!(ASSET_EXTENSIONS as readonly unknown[]).includes(extension))
    throw refuse('REQUEST_INVALID')
  const length = request.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    throw refuse('REQUEST_INVALID')
  if (length !== undefined && Number(length) > IMAGE_LIMITS.maxBytes)
    throw refuse('PAYLOAD_TOO_LARGE')
  const data = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const cleanup = (): void => {
      request.off('data', chunk)
      request.off('end', end)
      request.off('error', failed)
      request.off('aborted', interrupted)
      signal.removeEventListener('abort', interrupted)
    }
    const finish = (error?: Error): void => {
      if (settled)
        return
      settled = true
      cleanup()
      if (error !== undefined) {
        request.pause()
        chunks.length = 0
        reject(error)
      }
      else {
        resolve(Buffer.concat(chunks, bytes))
      }
    }
    function interrupted(): void {
      finish(imageAborted())
    }
    function failed(): void {
      finish(refuse('REQUEST_INVALID'))
    }
    function end(): void {
      finish(length !== undefined && bytes !== Number(length) ? refuse('REQUEST_INVALID') : undefined)
    }
    function chunk(value: Buffer): void {
      if (!Buffer.isBuffer(value)) {
        failed()
        return
      }
      bytes += value.length
      if (bytes > IMAGE_LIMITS.maxBytes)
        finish(refuse('PAYLOAD_TOO_LARGE'))
      else
        chunks.push(value)
    }
    if (signal.aborted || request.destroyed) {
      interrupted()
      return
    }
    if (request.readableEnded) {
      end()
      return
    }
    request.on('error', failed)
    request.on('aborted', interrupted)
    request.on('end', end)
    signal.addEventListener('abort', interrupted, { once: true })
    request.on('data', chunk)
  })
  return { data, mimeType: mimeType as AssetMimeType, extension: extension as AssetExtension }
}
