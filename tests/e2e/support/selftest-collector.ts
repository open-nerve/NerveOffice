// 收下页面自检交回的结果的本机 HTTP 服务（M4-P1 复核 B5）：页面整页跳到 next，结果在查询参数里。Playwright 一路由页面就关掉 HTTP 缓存
// （文档："Enabling routing disables http cache"），用 page.route 拦下交回的那次导航，同一页之后的导航都不进缓存——本机持久上下文的实测里
// 标成"热"的几步其实是冷的（脚本整个重传）。这里另起一个本机的源（127.0.0.1 的随机端口）接收，满足自检对 next 的限制（只能是本机的地址），
// 不碰页面的路由。真实 Safari 的驱动脚本有自己的收集端（还要把页面带到下一步）；Playwright 的校准仍用 page.route（只核对对不对，不量时间）
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

/** 交回的地址带着整份结果（压缩之后 base64url，一般几 KiB），比 Node 默认的 16 KiB 请求头长时也收得下（与驱动脚本的收集端相同） */
const MAX_REQUEST_HEADER_BYTES = 4 * 1024 * 1024

/** 交回结果的路径与标记参数：每次等交回用一个新的标记，前一步迟到或重复的交回不会被下一步收走 */
export const COLLECTOR_REPORT_PATH = '/report'
export const COLLECTOR_TOKEN_PARAM = 'expect'

export interface ResultCollector {
  /** 收集端的源（http://127.0.0.1:<端口>） */
  readonly origin: string
  /**
   * 等一次交回：next 交给页面（带一个只用这一次的标记）；delivered 是交回的整个地址，timeoutMs 之内没有交回就失败。
   * 同一个标记再交回一次（页面重复跳转）答 404，不算数
   */
  readonly expect: (timeoutMs: number) => { readonly next: string, readonly delivered: Promise<string> }
  readonly close: () => Promise<void>
}

export async function startResultCollector(): Promise<ResultCollector> {
  const waiting = new Map<string, (url: string) => void>()
  let origin = ''
  let issued = 0
  const server = createServer({ maxHeaderSize: MAX_REQUEST_HEADER_BYTES }, (request, response) => {
    const url = new URL(request.url ?? '/', origin)
    const token = url.searchParams.get(COLLECTOR_TOKEN_PARAM)
    const deliver = url.pathname === COLLECTOR_REPORT_PATH && token !== null ? waiting.get(token) : undefined
    if (token === null || deliver === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('收集端不认识这个地址（标记不对，或者这一次已经交回过）')
      return
    }
    waiting.delete(token)
    deliver(url.href)
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('自检的结果已收到')
  })
  // 浏览器预先建好、没用上就断开的连接不是问题
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    expect: (timeoutMs) => {
      issued += 1
      const token = String(issued)
      const next = `${origin}${COLLECTOR_REPORT_PATH}?${COLLECTOR_TOKEN_PARAM}=${token}`
      const delivered = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(token)
          reject(new Error(`${timeoutMs / 1000} 秒内自检没有把结果交回`))
        }, timeoutMs)
        // 用例提前结束时不让这个计时器拖住进程
        timer.unref()
        waiting.set(token, (url) => {
          clearTimeout(timer)
          resolve(url)
        })
      })
      return { next, delivered }
    },
    close: async () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
