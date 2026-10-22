import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Response } from 'express'
import type { Buffer } from 'node:buffer'
import type { Observable } from 'rxjs'
import { Injectable, StreamableFile } from '@nestjs/common'
import { map } from 'rxjs'

/** 历史原 gzip，不复用当前修订 ETag；即使同一历史也必须重新鉴权和复核保留期。 */
@Injectable()
export class HistoryContentInterceptor implements NestInterceptor<Buffer, StreamableFile> {
  intercept(context: ExecutionContext, next: CallHandler<Buffer>): Observable<StreamableFile> {
    const response = context.switchToHttp().getResponse<Response>()
    return next.handle().pipe(map((snapshot) => {
      response.setHeader('Content-Encoding', 'gzip')
      response.setHeader('Cache-Control', 'no-store')
      return new StreamableFile(snapshot, { type: 'application/json; charset=utf-8', length: snapshot.length })
    }))
  }
}
