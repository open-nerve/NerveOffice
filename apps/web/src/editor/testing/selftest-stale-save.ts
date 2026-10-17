// 仅自检：保留本页已经成功保存的租约在内存中，失权后一次提交真实持久正文，直接核对服务端栅栏。
// 不记录/上报 Cookie、CSRF 或租约令牌；不申请编辑权，也不重试。
// 与 selftest-request 的常量同理：此测试分块不能依赖 contracts，避免把 schema 的构造提前到 zod-jitless 之前。
// 单元测试使用正式协议常量发送请求，值漂移会使观察/准备失败。
const CSRF_TOKEN_HEADER = 'x-csrf-token'
const EDIT_LEASE_HEADER = 'x-edit-lease'
const SNAPSHOT_UPLOAD_CONTENT_TYPE = 'application/gzip'

export function observeStaleSelftestSave(documentId: string, origin: string, target: { fetch: typeof fetch } = window) {
  const original = target.fetch
  let disposed = false
  let saved: { url: URL, headers: Headers } | undefined
  let prepared: { url: URL, requestId: string, headers: Headers, compressed: Uint8Array<ArrayBuffer> } | undefined
  let attempted = false
  const observing: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const relevant = !disposed && prepared === undefined && method === 'PUT' && url.origin === origin && url.pathname === `/api/documents/${documentId}/content`
      && headers.has(EDIT_LEASE_HEADER) && headers.has(CSRF_TOKEN_HEADER) && headers.get('content-type') === SNAPSHOT_UPLOAD_CONTENT_TYPE
    const response = await original.call(target, input, init)
    if (relevant && response.ok && !disposed && prepared === undefined)
      saved = { url, headers }
    return response
  }
  target.fetch = observing
  return {
    prepare(options: { readonly clientInstanceId: string, readonly localSeq: number, readonly compressed: Uint8Array<ArrayBuffer> }): void {
      if (disposed || prepared !== undefined || saved === undefined || saved.url.searchParams.get('baseRevision') !== '2'
        || saved.url.searchParams.get('clientInstanceId') !== options.clientInstanceId || !Number.isSafeInteger(options.localSeq) || options.localSeq < 1 || options.compressed.byteLength === 0) {
        throw new Error('缺少本轮已成功的第二次保存，或旧保存准备重复、身份不符')
      }
      const url = new URL(saved.url)
      const requestId = crypto.randomUUID()
      url.searchParams.set('requestId', requestId)
      url.searchParams.set('baseRevision', '3')
      url.searchParams.set('localSeq', String(options.localSeq))
      prepared = { url, requestId, headers: new Headers(saved.headers), compressed: options.compressed.slice() }
      saved = undefined
    },
    async attempt() {
      if (disposed || prepared === undefined || attempted)
        throw new Error('旧保存未准备、已释放或不能重复提交')
      attempted = true
      const sentAt = Date.now()
      const response = await original.call(target, prepared.url.href, { method: 'PUT', headers: prepared.headers, credentials: 'same-origin', body: prepared.compressed, signal: AbortSignal.timeout(10_000) })
      const result = await response.json() as { error?: { code?: unknown, details?: { reason?: unknown } } }
      if (response.status !== 409 || result.error?.code !== 'EDIT_LEASE_LOST' || result.error.details?.reason !== 'replaced')
        throw new Error('旧保存未确认被服务端已替换代次规则拒绝')
      return { requestId: prepared.requestId, sentAt, answeredAt: Date.now(), status: 409 as const, code: 'EDIT_LEASE_LOST' as const, reason: 'replaced' as const }
    },
    dispose(): void {
      disposed = true
      saved = undefined
      prepared = undefined
      if (target.fetch === observing)
        target.fetch = original
    },
  }
}
