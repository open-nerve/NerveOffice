import type { BrowserContext, Page, Request, WebSocket } from '@playwright/test'

/**
 * 观察浏览器上下文里发往被测站点之外的请求（US-M5-14、A19）。按上下文观察：页面、Worker 与新页的 HTTP 请求都在 context 的
 * request 事件里（不访问 request.frame()）；WebSocket 握手不在其中，另按页面监听。第二设备等另开的上下文经 watch 加入。
 *
 * 能力限制（M5 整体审查 M5R-M-15、Q-09），断言时不能超出它：
 * - 记录的是浏览器交给网络层、由 Playwright 报出的请求，不是“尝试”。被 CSP 拦下的尝试是否出现在这里，随浏览器与资源类型而异：
 *   Chromium 里被 style-src 拦下的 @import 会出现（M5-P7 S11 实测），被 connect-src 拦下的 fetch 不出现（csp.spec 阳性对照的附件）。
 *   所以“零请求”不等于“零尝试”；CSP 违规另由 cspViolations 收集，而它只收页面里的，Worker 里的收不到；
 * - Playwright 不为以 /favicon.ico 结尾的地址发出 context 的请求事件（csp.spec 的对照）：这类地址只能靠目标服务的命中数判断；
 *   上下文开着请求拦截（挂了任意路由）时，Playwright 直接中止这类请求，连目标服务也收不到。macOS 上 WebKit 的持久上下文为隔离存储
 *   挂了路由（webkit-storage.ts），所以 macOS WebKit 的测试上下文里，以 /favicon.ico 结尾的请求出不了浏览器
 *   （M5-P8 托管 Mac 第 3 轮实测；csp.spec 的“macOS WebKit 挂了路由的上下文”对照固定这一事实）；
 *   要看这类请求的网络侧真值，须用不挂路由的上下文；
 * - 默认上下文在夹具结束之后才关闭，关闭期间的请求不在观察窗口内；经 watch 加入的上下文在关闭之前一直在窗口内。
 * 因此关键样本另用本地目标服务（servers.ts 的 startTargetServer），以服务端零命中作为网络侧的真值。
 */
export interface ExternalRequestWatch {
  readonly list: () => readonly string[]
  /** 再观察一个上下文（例如第二设备）；stop 时一起停 */
  readonly watch: (context: ObservedContext) => void
  readonly stop: () => void
}

export type ObservedContext = Pick<BrowserContext, 'on' | 'off' | 'pages'>

export function watchExternalRequests(context: ObservedContext, baseURL: string): ExternalRequestWatch {
  const site = new URL(baseURL)
  const external: string[] = []
  const stops: (() => void)[] = []
  const collect = (request: Request): void => {
    const url = new URL(request.url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== site.origin)
      external.push(url.href)
  }
  // 产品不用 WebSocket；握手的目标不在被测站点上就记下（ws/wss 与 http/https 按主机与端口比较）
  const socket = (webSocket: WebSocket): void => {
    const url = new URL(webSocket.url())
    if (url.host !== site.host)
      external.push(url.href)
  }
  const watchPage = (page: Page): void => {
    page.on('websocket', socket)
    stops.push(() => page.off('websocket', socket))
  }
  const watch = (target: ObservedContext): void => {
    target.on('request', collect)
    target.on('page', watchPage)
    stops.push(() => {
      target.off('request', collect)
      target.off('page', watchPage)
    })
    for (const page of target.pages())
      watchPage(page)
  }
  watch(context)
  return {
    list: () => [...external],
    watch,
    stop: () => {
      for (const stop of stops.splice(0))
        stop()
    },
  }
}
