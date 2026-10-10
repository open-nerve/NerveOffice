// 真实 HTTP 流的暂停夹具（M4-P2 S2）：页面通过本机代理访问真实后端，只扣住指定请求第一次的响应。
// 不替换 fetch/Response：浏览器确实收到响应头和未结束的正文；另从浏览器 requestfailed 核对 keepalive 的取消（传输连接可继续存活）。
// 代理自己的源映射到被测后端源，保留原站点的同源/CSRF 检查；请求内容与令牌只做内存哈希，不写日志或报告。
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { EDIT_LEASE_HEADER } from '@nerve-office/contracts'
import { e2eOrigin } from './environment.ts'

export type StallStage = 'headers' | 'body' | 'error-body'

export interface StalledResponse {
  readonly origin: string
  readonly received: () => boolean
  readonly closed: () => boolean
  readonly status: () => number | undefined
  readonly fingerprints: () => readonly string[]
  readonly release: () => void
  readonly close: () => Promise<void>
}

export async function startResponseStall(method: string, path: string, stage: StallStage): Promise<StalledResponse> {
  const upstream = new URL(e2eOrigin())
  if (upstream.protocol !== 'http:')
    throw new Error('暂停响应夹具只用于本机 HTTP 测试构建')
  let origin = ''
  let used = false
  let received = false
  let closed = false
  let status: number | undefined
  const fingerprints: string[] = []
  let deliver: () => void = () => {}
  const forwarding = new Set<ReturnType<typeof request>>()
  const server = createServer((incoming, response) => {
    const target = new URL(incoming.url ?? '/', upstream)
    const matches = incoming.method === method && target.pathname === path
    const stall = matches && !used
    if (stall)
      used = true
    if (matches) {
      const hash = createHash('sha256').update(`${incoming.method} ${target.pathname}${target.search}\n${String(incoming.headers[EDIT_LEASE_HEADER] ?? '')}\n`)
      incoming.on('data', (chunk: Buffer) => hash.update(chunk))
      incoming.on('end', () => fingerprints.push(hash.digest('hex')))
    }
    const headers = { ...incoming.headers, host: upstream.host }
    if (headers.origin === origin)
      headers.origin = upstream.origin
    if (headers.referer?.startsWith(`${origin}/`) === true)
      headers.referer = `${upstream.origin}${headers.referer.slice(origin.length)}`
    const sent = request(target, { method: incoming.method, headers }, (answer) => {
      if (!stall) {
        response.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(response)
        return
      }
      status = answer.statusCode
      const chunks: Buffer[] = []
      answer.on('data', (chunk: Buffer) => chunks.push(chunk))
      answer.on('end', () => {
        let body = Buffer.concat(chunks)
        let code = answer.statusCode ?? 502
        const heldHeaders = { ...answer.headers }
        if (stage === 'error-body') {
          code = 409
          body = Buffer.from(JSON.stringify({ error: { code: 'CONTENT_INVALID', message: '未完整送达的拒绝' } }))
          delete heldHeaders['content-encoding']
          delete heldHeaders['transfer-encoding']
          heldHeaders['content-length'] = String(body.byteLength)
        }
        if (stage !== 'headers') {
          response.writeHead(code, heldHeaders)
          response.flushHeaders()
          response.write(body.subarray(0, 1))
        }
        // 后端已经完整回答（保存已经提交），但浏览器还在等待；正文模式已送头和第一个字节。
        received = true
        deliver = () => finish(response, code, heldHeaders, body, stage)
      })
      answer.on('error', error => response.destroy(error))
    })
    forwarding.add(sent)
    sent.on('close', () => forwarding.delete(sent))
    sent.on('error', error => response.destroy(error))
    response.on('close', () => {
      if (stall)
        closed = true
      sent.destroy()
    })
    incoming.on('error', error => sent.destroy(error))
    incoming.pipe(sent)
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    received: () => received,
    closed: () => closed,
    status: () => status,
    fingerprints: () => [...fingerprints],
    release: () => deliver(),
    close: async () => new Promise<void>((resolve) => {
      for (const sent of forwarding)
        sent.destroy()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

function finish(response: ServerResponse, code: number, headers: OutgoingHttpHeaders, body: Buffer, stage: StallStage): void {
  if (response.destroyed || response.writableEnded)
    return
  if (stage === 'headers')
    response.writeHead(code, headers)
  response.end(stage === 'headers' ? body : body.subarray(1))
}
