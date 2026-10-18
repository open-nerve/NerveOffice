import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { Observable } from 'rxjs'
import type { ImageInputReader } from './asset-upload.service.ts'
import { createParamDecorator, Injectable } from '@nestjs/common'
import { finalize } from 'rxjs'
import { readAssetBody } from './asset-body.ts'

export interface AssetUploadInput { readonly read: ImageInputReader, readonly signal: AbortSignal }
const INPUT = Symbol('asset-upload')
interface UploadRequest extends Request { [INPUT]?: AssetUploadInput }

/** 守卫之后只装配可取消的延迟 reader；服务取得名额才读正文，生命周期覆盖处理、发布与转正。 */
@Injectable()
export class AssetUploadInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<UploadRequest>()
    const response = context.switchToHttp().getResponse<Response>()
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const close = (): void => {
      if (!response.writableFinished)
        abort()
    }
    request.on('aborted', abort)
    response.on('close', close)
    if (request.destroyed || response.destroyed)
      abort()
    request[INPUT] = { signal: controller.signal, read: async signal => readAssetBody(request, signal) }
    return next.handle().pipe(finalize(() => {
      request.off('aborted', abort)
      response.off('close', close)
      delete request[INPUT]
    }))
  }
}

export const AssetUpload = createParamDecorator((_data: unknown, context: ExecutionContext): AssetUploadInput => {
  const input = context.switchToHttp().getRequest<UploadRequest>()[INPUT]
  if (input === undefined)
    throw new Error('上传入口没有装配原始请求读取')
  return input
})
