// 各编辑请求的应用时限：真实请求层与 Response 流，只暂停传输，不替换时限模块。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDefiniteRejection, isTransientError, isUnknownOutcome, RequestTimeoutError } from '../../shared/api/index.ts'
import { acquireEditLease, cancelEditRequest, declineEditRequest, fetchContent, fetchContentIfChanged, fetchDocument, fetchEditStatus, handOverEditLease, releaseEditLease, renewEditLease, renewEditRequest, saveConflictCopy, saveContent, sendEditRequest } from './editor-api.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const PAGE_ID = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const TOKEN = 'T'.repeat(43)
const QUERY = { requestId: 'request-1', title: '周报' }
const SAVE = { requestId: 'request-1', clientInstanceId: PAGE_ID, localSeq: 2, baseRevision: 4, snapshot: '{}', formulasPending: false }
const GZIP = new Uint8Array([31, 139, 8])
const cleanup: (() => void)[] = []

type Waiting = 'headers' | 'success-body' | 'error-body'

function pauseResponse(waiting: Waiting) {
  let signal: AbortSignal | null | undefined
  let stream: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined
  let deliver: (response: Response) => void = () => {}
  const response = new Response(new ReadableStream<Uint8Array<ArrayBuffer>>({
    start: (controller) => { stream = controller },
  }), {
    status: waiting === 'error-body' ? 409 : 200,
    headers: { etag: '"4"' },
  })
  const headers = new Promise<Response>((resolve) => {
    deliver = resolve
  })
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    signal = init?.signal
    return waiting === 'headers' ? headers : response
  })
  vi.stubGlobal('fetch', fetch)
  cleanup.push(() => {
    stream?.close()
    deliver(response)
  })
  return { fetch, signal: () => signal }
}

function observe(promise: Promise<unknown>) {
  let result: { kind: 'done' } | { kind: 'failed', error: unknown } | undefined
  void promise.then(() => {
    result = { kind: 'done' }
  }, (error: unknown) => {
    result = { kind: 'failed', error }
  })
  return () => result
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const release of cleanup.splice(0))
    release()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const cases = [
  { name: '保存', limit: 60_000, body: true, run: async () => saveContent(DOCUMENT_ID, SAVE, GZIP, { token: TOKEN, writeEpoch: 2 }) },
  { name: '另存副本', limit: 60_000, body: true, run: async () => saveConflictCopy(DOCUMENT_ID, QUERY, GZIP) },
  { name: '申请租约', limit: 10_000, body: true, run: async () => acquireEditLease(DOCUMENT_ID, PAGE_ID) },
  { name: '续上租约', limit: 10_000, body: true, run: async () => acquireEditLease(DOCUMENT_ID, PAGE_ID, { idleSeconds: 5 }) },
  { name: '核对租约', limit: 10_000, body: true, run: async () => fetchEditStatus(DOCUMENT_ID) },
  { name: '心跳续租', limit: 10_000, body: true, run: async () => renewEditLease(DOCUMENT_ID, TOKEN, 5) },
  { name: '释放租约', limit: 10_000, body: false, run: async () => releaseEditLease(DOCUMENT_ID, TOKEN) },
  { name: '请求编辑', limit: 10_000, body: true, run: async () => sendEditRequest(DOCUMENT_ID) },
  { name: '续期请求', limit: 10_000, body: true, run: async () => renewEditRequest(DOCUMENT_ID) },
  { name: '取消请求', limit: 10_000, body: false, run: async () => cancelEditRequest(DOCUMENT_ID) },
  { name: '谢绝请求', limit: 10_000, body: false, run: async () => declineEditRequest(DOCUMENT_ID, TOKEN, QUERY.requestId) },
  { name: '交出租约', limit: 10_000, body: true, run: async () => handOverEditLease(DOCUMENT_ID, TOKEN, QUERY.requestId) },
  { name: '文档详情', limit: 30_000, body: true, run: async () => fetchDocument(DOCUMENT_ID) },
  { name: '内容全文', limit: 30_000, body: true, run: async () => fetchContent(DOCUMENT_ID) },
  { name: '条件读取', limit: 30_000, body: true, run: async () => fetchContentIfChanged(DOCUMENT_ID, 3) },
]

describe.each(cases)('$name的时限是 $limit 毫秒', ({ run, limit, body }) => {
  const waits: Waiting[] = body ? ['headers', 'success-body', 'error-body'] : ['headers', 'error-body']
  it.each(waits)('%s 挂住时按总时限结束，结果仍然未知', async (waiting) => {
    const remote = pauseResponse(waiting)
    const result = observe(run())
    await vi.advanceTimersByTimeAsync(limit - 1)
    expect(remote.fetch).toHaveBeenCalledTimes(1)
    expect(result()).toBeUndefined()
    expect(remote.signal()?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const outcome = result()
    expect(outcome).toMatchObject({ kind: 'failed', error: { timeoutMs: limit } })
    if (outcome?.kind !== 'failed')
      throw new Error('请求没有按时结束')
    expect(outcome.error).toBeInstanceOf(RequestTimeoutError)
    expect(isDefiniteRejection(outcome.error)).toBe(false)
    expect(isUnknownOutcome(outcome.error)).toBe(true)
    expect(isTransientError(outcome.error)).toBe(true)
    expect(remote.signal()?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
