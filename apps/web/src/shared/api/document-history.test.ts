import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakeApi } from '../testing/fake-api.test-support.ts'
import { RequestTimeoutError } from './api-errors.ts'
import { fetchHistoryContent, HistoryContentError } from './document-history.ts'

const DOC = '0199a2c4-0000-7000-8000-0000000000d1'
const HISTORY = '0199a2c4-0000-7000-8000-0000000000e1'
const CONTENT = `GET /api/documents/${DOC}/history/${HISTORY}/content`

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('M5R-M-05 历史正文的读取', () => {
  it('正常读出原文', async () => {
    installFakeApi({ [CONTENT]: () => new Response('{"history":true}') })
    await expect(fetchHistoryContent(DOC, HISTORY)).resolves.toBe('{"history":true}')
  })

  it('收到响应却读不出正文（解 gzip 失败）：按数据问题报 HistoryContentError', async () => {
    installFakeApi({ [CONTENT]: () => new Response(new ReadableStream({ start: controller => controller.error(new TypeError('解码失败')) })) })
    await expect(fetchHistoryContent(DOC, HISTORY)).rejects.toBeInstanceOf(HistoryContentError)
  })

  it('读正文期间到了请求时限：仍是超时（网络类，可自动重试），不算数据问题', async () => {
    vi.useFakeTimers()
    installFakeApi({ [CONTENT]: (init) => {
      const signal = init?.signal ?? undefined
      return new Response(new ReadableStream({
        start: (controller) => {
          signal?.addEventListener('abort', () => controller.error(signal.reason))
        },
      }))
    } })
    const outcome = fetchHistoryContent(DOC, HISTORY).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await outcome).toBeInstanceOf(RequestTimeoutError)
  })
})
