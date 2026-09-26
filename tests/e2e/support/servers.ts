// CSP 阳性对照用的两个本机服务（P3 设计 §3.9）：
// - 目标：另一个源，允许跨源读取；策略生效时探针的请求到不了它，没有策略时能到；
// - 对照：不带任何安全头地提供同一份测试构建，证明探针本身有效。
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = fileURLToPath(new URL('../../../apps/web/dist-e2e', import.meta.url))

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
}

export interface LocalServer {
  readonly origin: string
  /** 收到的请求数 */
  readonly hits: () => number
  close: () => Promise<void>
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ origin: string, close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

export async function startTargetServer(): Promise<LocalServer> {
  let hits = 0
  const server = await listen((_request, response) => {
    hits += 1
    response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
    response.end('reachable')
  })
  return { ...server, hits: () => hits }
}

export async function startControlServer(): Promise<LocalServer> {
  let hits = 0
  const server = await listen((request, response) => {
    hits += 1
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname))
    const file = join(WEB_ROOT, path === '/' ? 'index.html' : path)
    if (!file.startsWith(WEB_ROOT)) {
      response.writeHead(403).end()
      return
    }
    readFile(file).then((content) => {
      response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
      response.end(content)
    }, () => {
      response.writeHead(404).end()
    })
  })
  return { ...server, hits: () => hits }
}
