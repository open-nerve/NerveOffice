// 本次真实 Safari 运行自有的同源代理。应用请求原样流过；控制路径只调用测试会话，不提供进程或产品操作。
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CrashServerEvidence } from '../support/crash-session.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { request as backendRequest, createServer } from 'node:http'

interface Scenario {
  readonly documentId: string
  /** 现有 selftest 入口的合成测试账户片段；不写入报告或标准输出。 */
  readonly entryFragment: string
  readonly receive: (message: unknown, now: number) => { readonly kind: string }
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function smallBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes <= limit)
        chunks.push(data)
    })
    request.once('end', () => resolve(bytes > limit ? undefined : Buffer.concat(chunks)))
    request.once('error', reject)
  })
}

export async function startScenarioProxy(options: { readonly purpose: 'crash' | 'pause', readonly runId: string, readonly backendOrigin: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(options.runId))
    throw new Error('无效的崩溃运行标识')
  const backend = new URL(options.backendOrigin)
  if (backend.origin !== options.backendOrigin || backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1' || Number(backend.port) < 1024)
    throw new Error('后端必须是本次自有的本机端口')
  const prefix = `/__nerve-${options.purpose}`
  const title = options.purpose === 'crash' ? '崩溃验证' : '暂停恢复验证'
  const controlLimit = options.purpose === 'crash' ? 8192 : 65_536
  const controlPath = `${prefix}/${options.runId}`
  const startPath = `${prefix}-start/${options.runId}`
  const commandPath = `${prefix}-command/${options.runId}`
  const entryPath = `${prefix}-entry/${options.runId}`
  let origin = ''
  let scenario: Scenario | undefined
  let armed = false
  let entryUsed = false
  let recoveryEntryGranted = false
  let observing = false
  const acquires: { clientInstanceId: string, takeover: string | null, status: number }[] = []
  const saves: { status: number }[] = []
  const problems: string[] = []
  const upstreams = new Set<ClientRequest>()
  let clientAborts = 0

  const control = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST' || request.headers.origin !== origin) {
      reply(response, 403, { kind: 'stop' })
      return
    }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      reply(response, 415, { kind: 'stop' })
      return
    }
    const body = await smallBody(request, controlLimit)
    if (body === undefined) {
      reply(response, 413, { kind: 'stop' })
      return
    }
    let message: unknown
    try {
      message = JSON.parse(body.toString('utf8'))
    }
    catch {
      reply(response, 400, { kind: 'stop' })
      return
    }
    if (request.url === commandPath) {
      reply(response, 200, { kind: armed ? 'start' : 'wait' })
      return
    }
    if (!armed || scenario === undefined) {
      reply(response, 403, { kind: 'stop' })
      return
    }
    reply(response, 200, scenario.receive(message, Date.now()))
  }

  const forward = (request: IncomingMessage, response: ServerResponse): void => {
    let clientAborted = false
    let upstreamFailed = false
    const failUpstream = (): void => {
      if (!clientAborted && !upstreamFailed) {
        upstreamFailed = true
        problems.push('后端代理连接失败')
      }
    }
    const path = new URL(request.url ?? '/', origin).pathname
    const acquire = observing && request.method === 'POST' && path === `/api/documents/${scenario?.documentId}/edit-lease`
    const save = observing && request.method === 'PUT' && path === `/api/documents/${scenario?.documentId}/content`
    const item = acquire ? { clientInstanceId: '', takeover: null as string | null, status: 0 } : undefined
    const saved = save ? { status: 0 } : undefined
    if (item !== undefined)
      acquires.push(item)
    if (saved !== undefined)
      saves.push(saved)
    const chunks: Buffer[] = []
    let bytes = 0
    if (item !== undefined) {
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes <= 8192)
          chunks.push(chunk)
      })
      request.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (bytes > 8192 || typeof body !== 'object' || body === null || !('clientInstanceId' in body) || typeof body.clientInstanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.clientInstanceId))
            throw new Error('invalid')
          const takeover = 'takeover' in body ? body.takeover : null
          if (takeover !== null && typeof takeover !== 'string')
            throw new Error('invalid')
          item.clientInstanceId = body.clientInstanceId
          item.takeover = takeover
        }
        catch {
          problems.push('恢复后的申请正文无法核对')
        }
      })
    }
    // 目标固定；不把请求的绝对 URL 当成转发地址。Cookie、Origin、gzip 和应用 CSP 不作改写。
    const upstream = backendRequest({ hostname: backend.hostname, port: backend.port, path: request.url, method: request.method, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers)
      result.on('end', () => {
        if (item !== undefined)
          item.status = result.statusCode ?? 0
        if (saved !== undefined)
          saved.status = result.statusCode ?? 0
      })
      result.on('error', () => {
        failUpstream()
        response.destroy()
      })
      result.pipe(response)
    })
    upstreams.add(upstream)
    upstream.once('close', () => upstreams.delete(upstream))
    upstream.on('error', () => {
      failUpstream()
      if (!response.headersSent)
        reply(response, 502, { error: 'backend unavailable' })
      else
        response.destroy()
    })
    const abortClient = (): void => {
      if (!clientAborted && !upstreamFailed) {
        clientAborted = true
        clientAborts += 1
      }
      upstream.destroy()
    }
    request.on('aborted', abortClient)
    response.on('close', () => {
      if (!response.writableFinished)
        abortClient()
    })
    request.pipe(upstream)
  }

  const server = createServer((request, response) => {
    if (request.headers.host !== new URL(origin).host || request.socket.remoteAddress !== '127.0.0.1' || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      reply(response, 403, { kind: 'stop' })
      return
    }
    if (request.url === startPath && request.method === 'GET') {
      const nonce = randomBytes(16).toString('base64')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` })
      response.end(`<!doctype html><meta charset="utf-8"><title>NerveOffice Safari ${title}</title><h1>NerveOffice Safari ${title}</h1><p>专用测试页面已就绪。等待桌面空闲两分钟后自动开始；请保持此窗口可见。</p><script nonce="${nonce}">const timer = setInterval(async () => { try { const r = await fetch('${commandPath}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const c = await r.json(); if (c.kind === 'start') { clearInterval(timer); location.replace('${entryPath}'); } } catch { clearInterval(timer); document.querySelector('p').textContent = '本次验证服务已结束。'; } }, 500);</script>`)
    }
    else if (request.url === controlPath || request.url === commandPath) {
      void control(request, response).catch(() => {
        problems.push('控制请求未完整处理')
        if (!response.headersSent)
          reply(response, 400, { kind: 'stop' })
      })
    }
    else if (request.url === entryPath) {
      if (request.method !== 'GET' || !armed || entryUsed || scenario === undefined || request.headers.referer !== `${origin}${startPath}`) {
        reply(response, 403, { kind: 'stop' })
        return
      }
      entryUsed = true
      response.writeHead(302, { 'location': `/selftest.html#${scenario.entryFragment}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      response.end()
    }
    else if (/^\/__nerve-(?:crash|pause)/.test(request.url)) {
      reply(response, 404, { kind: 'stop' })
    }
    else {
      forward(request, response)
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    startUrl: `${origin}${startPath}`,
    controlPath,
    commandPath,
    entryPath,
    configure(value: Scenario): void {
      if (scenario !== undefined || !/^[0-9a-f-]{36}$/i.test(value.documentId) || /[\r\n]/.test(value.entryFragment))
        throw new Error('崩溃场景已配置或身份格式无效')
      scenario = { ...value }
    },
    arm(): void {
      if (scenario === undefined || armed)
        throw new Error('崩溃场景未配置或已启动')
      armed = true
    },
    observeRecovery(): void {
      if (observing)
        throw new Error('不能重复标记真实崩溃')
      observing = true
    },
    /** 仅宿主驱动在核对 VM 重启之后调用；网页没有对应控制命令。 */
    allowRecoveryEntry(): void {
      if (options.purpose !== 'crash' || !armed || !entryUsed || !observing || recoveryEntryGranted)
        throw new Error('恢复登录入口尚未满足前提或已续发')
      recoveryEntryGranted = true
      entryUsed = false
    },
    evidence: (): Pick<CrashServerEvidence, 'acquires' | 'saves'> & { problems: string[], clientAborts: number } => ({ acquires: acquires.map(item => ({ ...item })), saves: saves.map(item => ({ ...item })), problems: [...problems], clientAborts }),
    close: async (): Promise<void> => {
      for (const upstream of upstreams)
        upstream.destroy()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
