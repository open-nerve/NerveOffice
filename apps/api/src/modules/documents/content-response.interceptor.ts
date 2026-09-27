import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Response } from 'express'
import type { Observable } from 'rxjs'
import type { DocumentContent } from './document-content.service.ts'
import { revisionEtag } from '@nerve-office/contracts'
import { Injectable, StreamableFile } from '@nestjs/common'
import { map } from 'rxjs'

/**
 * 读取内容的响应（P4 设计 §3.5.4）：数据库里的 gzip 字节原样下发，浏览器按 Content-Encoding 自动解压；
 * 修订号作 ETag。控制器只返回值对象，响应头与正文由这里写（控制器不接触响应对象，P2 设计 §3.1）。
 * Cache-Control 沿用安全响应头的 no-store。
 */
@Injectable()
export class ContentResponseInterceptor implements NestInterceptor<DocumentContent, StreamableFile> {
  intercept(context: ExecutionContext, next: CallHandler<DocumentContent>): Observable<StreamableFile> {
    const response = context.switchToHttp().getResponse<Response>()
    return next.handle().pipe(map((content) => {
      response.setHeader('Content-Encoding', 'gzip')
      response.setHeader('ETag', revisionEtag(content.revision))
      return new StreamableFile(content.snapshot, { type: 'application/json; charset=utf-8', length: content.snapshot.length })
    }))
  }
}
