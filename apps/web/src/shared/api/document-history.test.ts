import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakeApi, inTurn, networkFailure } from '../testing/fake-api.test-support.ts'
import { NetworkError, RequestTimeoutError } from './api-errors.ts'
import { fetchHistoryContent, HistoryContentError } from './document-history.ts'

const DOC = '0199a2c4-0000-7000-8000-0000000000d1'
const HISTORY = '0199a2c4-0000-7000-8000-0000000000e1'
const CONTENT = `GET /api/documents/${DOC}/history/${HISTORY}/content`
/** 收到响应、读正文时出错：浏览器解 gzip 失败与读正文途中断网都是这样 */
const unreadable = () => new Response(new ReadableStream({ start: controller => controller.error(new TypeError('读不出')) }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('M5R-M-05 历史正文的读取', () => {
  it('正常读出原文', async () => {
    installFakeApi({ [CONTENT]: () => new Response('{"history":true}') })
    await expect(fetchHistoryContent(DOC, HISTORY)).resolves.toBe('{"history":true}')
  })

  it('收到响应却读不出正文（解 gzip 失败）：连续两次都读不出，才按数据问题报 HistoryContentError', async () => {
    const api = installFakeApi({ [CONTENT]: unreadable })
    await expect(fetchHistoryContent(DOC, HISTORY)).rejects.toBeInstanceOf(HistoryContentError)
    expect(api.requests.filter(request => request.key === CONTENT)).toHaveLength(2)
  })

  it('读正文途中断网与解 gzip 失败单次分不清：先完整重读一次，读出就照常返回（S14 审查 FE3）', async () => {
    const api = installFakeApi({ [CONTENT]: inTurn(unreadable, () => new Response('{"history":true}')) })
    await expect(fetchHistoryContent(DOC, HISTORY)).resolves.toBe('{"history":true}')
    expect(api.requests.filter(request => request.key === CONTENT)).toHaveLength(2)
  })

  it('重读时断网仍在：按网络错误报（预览可自动重试），不判为数据问题', async () => {
    installFakeApi({ [CONTENT]: inTurn(unreadable, networkFailure) })
    await expect(fetchHistoryContent(DOC, HISTORY)).rejects.toBeInstanceOf(NetworkError)
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
