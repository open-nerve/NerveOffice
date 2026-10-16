import type { Page } from '@playwright/test'

interface RejectedResponse { readonly status: number, readonly body: unknown }

/** 观察应用对原响应的真实读取；在交回 JSON 前完成取证，避免整页跳转销毁 CDP 的 Response。 */
function observeRejection(pathname: string): void {
  const observed = window as typeof window & { __recordAuthRejection: (response: RejectedResponse) => Promise<void> }
  const fetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const response = await fetch(input, init)
    if (response.status === 401 && new URL(response.url).pathname === pathname) {
      const json = response.json.bind(response)
      response.json = async () => {
        const body: unknown = await json()
        await observed.__recordAuthRejection({ status: response.status, body })
        return body
      }
    }
    return response
  }
}

export async function captureRejection(page: Page, pathname: string): Promise<() => RejectedResponse | undefined> {
  let first: RejectedResponse | undefined
  await page.exposeFunction('__recordAuthRejection', (response: RejectedResponse) => {
    first ??= response
  })
  await page.addInitScript(observeRejection, pathname)
  // “加载更多”消费当前 Document，其余场景导航后由 init script 安装。保留原 fetch/Response/Cookie，不补发请求。
  await page.evaluate(observeRejection, pathname)
  return () => first
}
