import type { AssetExtension, AssetMimeType } from '@nerve-office/contracts'
import type { Request } from 'express'
import type { ImageProcessingInput } from './image-types.ts'
import { Buffer } from 'node:buffer'
import { ASSET_EXTENSIONS, ASSET_MIME_TYPES } from '@nerve-office/contracts'
import { AppError } from '../../shared/errors/app-error.ts'
import { imageAborted } from './image-admission.ts'
import { IMAGE_LIMITS } from './image-types.ts'

/** 有限正文读完再回包关闭，避免代理还在写入时收到 broken pipe 而把业务拒绝变成 502。 */
function refuse(code: 'UNSUPPORTED_MEDIA_TYPE' | 'REQUEST_INVALID' | 'PAYLOAD_TOO_LARGE'): AppError {
  return new AppError(code, undefined, { headers: { Connection: 'close' } })
}

export async function readAssetBody(request: Request, signal: AbortSignal): Promise<ImageProcessingInput> {
  const mimeType = request.headers['content-type']?.toLowerCase()
  const encoding = request.headers['content-encoding']?.toLowerCase()
  const rawExtension = request.headers['x-asset-extension']
  const extension = typeof rawExtension === 'string' && /^[A-Z]+$/i.test(rawExtension) ? rawExtension.toLowerCase() : undefined
  const length = request.headers['content-length']
  let headerError: AppError | undefined
  if (!(ASSET_MIME_TYPES as readonly unknown[]).includes(mimeType) || (encoding !== undefined && encoding !== 'identity'))
    headerError = refuse('UNSUPPORTED_MEDIA_TYPE')
  else if (!(ASSET_EXTENSIONS as readonly unknown[]).includes(extension))
    headerError = refuse('REQUEST_INVALID')
  else if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    headerError = refuse('REQUEST_INVALID')
  else if (length !== undefined && Number(length) > IMAGE_LIMITS.maxBytes)
    headerError = refuse('PAYLOAD_TOO_LARGE')
  const data = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    let rejection: AppError | undefined
    let rejectionTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      clearTimeout(rejectionTimer)
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
    const stop = (): void => {
      finish(rejection)
      // 清理预算已耗尽，不能先回包再任由 Node 隐式排空任意长的正文。
      request.destroy()
    }
    const discard = (error: AppError): void => {
      if (rejection !== undefined)
        return
      rejection = error
      chunks.length = 0
      rejectionTimer = setTimeout(stop, IMAGE_LIMITS.rejectedBodyMs)
      rejectionTimer.unref()
    }
    function interrupted(): void {
      finish(imageAborted())
    }
    function failed(): void {
      finish(refuse('REQUEST_INVALID'))
    }
    function end(): void {
      finish(rejection ?? (length !== undefined && bytes !== Number(length) ? refuse('REQUEST_INVALID') : undefined))
    }
    function chunk(value: Buffer): void {
      if (!Buffer.isBuffer(value)) {
        failed()
        return
      }
      bytes += value.length
      if (rejection === undefined && bytes > IMAGE_LIMITS.maxBytes)
        discard(refuse('PAYLOAD_TOO_LARGE'))
      if (rejection !== undefined) {
        if (bytes > IMAGE_LIMITS.maxRejectedBodyBytes)
          stop()
      }
      else {
        chunks.push(value)
      }
    }
    if (signal.aborted || request.destroyed) {
      interrupted()
      return
    }
    if (headerError !== undefined)
      discard(headerError)
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
