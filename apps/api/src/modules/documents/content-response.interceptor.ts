import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Response } from 'express'
import type { Observable } from 'rxjs'
import type { ContentRead } from './document-content.service.ts'
import { revisionEtag } from '@nerve-office/contracts'
import { HttpStatus, Injectable, StreamableFile } from '@nestjs/common'
import { map } from 'rxjs'

/**
 * 读取内容的响应（P4 设计 §3.5.4）：数据库里的 gzip 字节原样下发，浏览器按 Content-Encoding 自动解压；
 * 修订号作 ETag。控制器只返回值对象，响应头与正文由这里写（控制器不接触响应对象，P2 设计 §3.1）。
 * Cache-Control 沿用安全响应头的 no-store。
 * 条件请求认出没变（M3-P2 设计 §3.2，DEF-017）：304，只带 ETag（RFC 9110 §15.4.5：200 会带的 ETag 照带），
 * 不带正文与 Content-Encoding（那是正文的元数据）。状态码在这里改：Nest 在拦截器之前按方法设好 200，之后发送时不再改它
 * （Nest 12 的写法；哪天它在发送时重设状态码，304 就会变成没有正文的 200，集成测试 documents/content.test.ts 按状态码核对）；
 * 没有正文时 Express 去掉内容类型与长度
 */
@Injectable()
export class ContentResponseInterceptor implements NestInterceptor<ContentRead, StreamableFile | undefined> {
  intercept(context: ExecutionContext, next: CallHandler<ContentRead>): Observable<StreamableFile | undefined> {
    const response = context.switchToHttp().getResponse<Response>()
    return next.handle().pipe(map((read) => {
      if (read.kind === 'notModified') {
        response.status(HttpStatus.NOT_MODIFIED)
        response.setHeader('ETag', revisionEtag(read.revision))
        return undefined
      }
      const { content } = read
      response.setHeader('Content-Encoding', 'gzip')
      response.setHeader('ETag', revisionEtag(content.revision))
      return new StreamableFile(content.snapshot, { type: 'application/json; charset=utf-8', length: content.snapshot.length })
    }))
  }
}
