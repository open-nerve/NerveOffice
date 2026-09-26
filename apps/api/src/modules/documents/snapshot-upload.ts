// 快照的上传（P4 设计 §3.3、§3.5.1）：PUT 的正文是 gzip 压缩的快照 JSON 字节，不经全局的 JSON 解析器。
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { Observable } from 'rxjs'
import type { GzipBody } from '../security/index.ts'
import { SNAPSHOT_MAX_RAW_BYTES, SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { createParamDecorator, Injectable } from '@nestjs/common'
import { readGzipBody } from '../security/index.ts'

/** 压缩后与解压后都以快照的上限为限。 */
const SNAPSHOT_LIMITS = { maxCompressedBytes: SNAPSHOT_MAX_RAW_BYTES, maxRawBytes: SNAPSHOT_MAX_RAW_BYTES }

const SNAPSHOT_UPLOAD: unique symbol = Symbol('nerve-office:snapshot-upload')

interface UploadRequest extends Request {
  [SNAPSHOT_UPLOAD]?: GzipBody
}

/**
 * 读取并解压上传的快照，挂到请求上。拦截器在守卫之后执行：没有登录、CSRF 或 Origin 不对的请求不读取、不解压。
 * 查询参数的校验（管道）在拦截器之后，格式不对的请求也会先读完正文，只多花一次读取。
 */
@Injectable()
export class SnapshotUploadInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp()
    const request = http.getRequest<UploadRequest>()
    request[SNAPSHOT_UPLOAD] = await readGzipBody(request, http.getResponse<Response>(), SNAPSHOT_UPLOAD_CONTENT_TYPE, SNAPSHOT_LIMITS)
    return next.handle()
  }
}

/** 控制器的参数装饰器：`save(@SnapshotUpload() upload: GzipBody)`。只能用在挂了 SnapshotUploadInterceptor 的接口上。 */
export const SnapshotUpload = createParamDecorator((_data: unknown, context: ExecutionContext): GzipBody => {
  const upload = context.switchToHttp().getRequest<UploadRequest>()[SNAPSHOT_UPLOAD]
  if (upload === undefined)
    throw new Error('没有读取上传的快照：@SnapshotUpload() 只能用在挂了 SnapshotUploadInterceptor 的接口上')
  return upload
})
