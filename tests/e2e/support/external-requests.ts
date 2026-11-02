import type { BrowserContext, Request } from '@playwright/test'

/** 不访问 request.frame()：页面、Worker 和新页统一按整个 context 的实际请求观察。 */
export function watchExternalRequests(context: Pick<BrowserContext, 'on' | 'off'>, baseURL: string): { readonly list: () => readonly string[], readonly stop: () => void } {
  const origin = new URL(baseURL).origin
  const external: string[] = []
  const collect = (request: Request): void => {
    const url = new URL(request.url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin)
      external.push(url.href)
  }
  context.on('request', collect)
  return {
    list: () => [...external],
    stop: () => { context.off('request', collect) },
  }
}
