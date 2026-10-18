import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Response } from 'express'
import type { Observable } from 'rxjs'
import type { AssetReadResult } from './asset-reading.service.ts'
import { ASSET_STATUS_HEADER } from '@nerve-office/contracts'
import { Injectable, StreamableFile } from '@nestjs/common'
import { map } from 'rxjs'
import { DATABASE_BUSY_RETRY_AFTER_SECONDS } from '../database/index.ts'

/** 只做传输。流式发送不走 Express send 的条件响应转换，GET/HEAD 每次都先完成完整授权。 */
@Injectable()
export class AssetResponseInterceptor implements NestInterceptor<AssetReadResult, StreamableFile> {
  intercept(context: ExecutionContext, next: CallHandler<AssetReadResult>): Observable<StreamableFile> {
    const response = context.switchToHttp().getResponse<Response>()
    return next.handle().pipe(map((image) => {
      response.setHeader(ASSET_STATUS_HEADER, String(image.status))
      response.setHeader('Cache-Control', image.status === 200 ? 'private, no-store' : 'no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      if (image.status === 503)
        response.setHeader('Retry-After', String(DATABASE_BUSY_RETRY_AFTER_SECONDS))
      return new StreamableFile(image.data, { type: image.mimeType, length: image.data.byteLength })
    }))
  }
}
