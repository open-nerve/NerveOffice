// 读取内容的响应（P4 设计 §3.5.4，M3-P2 设计 §3.2）：200 下发 gzip 字节、修订号作 ETag；条件请求认出没变时 304、只带 ETag。
// 经真实的 HTTP 管线（状态码、响应头、没有正文）见集成测试（documents/content.test.ts）。
import type { CallHandler, ExecutionContext } from '@nestjs/common'
import type { ContentRead } from './document-content.service.ts'
import { Buffer } from 'node:buffer'
import { StreamableFile } from '@nestjs/common'
import { lastValueFrom, of } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import { ContentResponseInterceptor } from './content-response.interceptor.ts'

function intercepted(read: ContentRead) {
  const response = { status: vi.fn(), setHeader: vi.fn() }
  const context = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ExecutionContext
  const next: CallHandler<ContentRead> = { handle: () => of(read) }
  return { response, result: lastValueFrom(new ContentResponseInterceptor().intercept(context, next)) }
}

describe('ContentResponseInterceptor', () => {
  it('当前内容：200（不改状态码），Content-Encoding: gzip，修订号作 ETag，正文是存下的字节', async () => {
    const snapshot = Buffer.from('gzip bytes')
    const { response, result } = intercepted({ kind: 'current', content: { revision: 4, snapshot } })
    const body = await result
    expect(body).toBeInstanceOf(StreamableFile)
    expect(response.status).not.toHaveBeenCalled()
    expect(response.setHeader.mock.calls).toEqual([['Content-Encoding', 'gzip'], ['ETag', '"4"']])
  })

  it('US-M3-05 没变（If-None-Match 是当前修订）：304，只带 ETag，没有正文与 Content-Encoding', async () => {
    const { response, result } = intercepted({ kind: 'notModified', revision: 4 })
    expect(await result).toBeUndefined()
    expect(response.status).toHaveBeenCalledExactlyOnceWith(304)
    expect(response.setHeader.mock.calls).toEqual([['ETag', '"4"']])
  })
})
