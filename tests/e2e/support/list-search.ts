// 管理界面的列表按关键词搜索（M2-P6 复核第四批）：输入停下 300ms 之后才按关键词重新请求，这期间表格换成加载状态，结果回来之后
// 才是过滤之后的行。没等过滤完成就去点行里的操作，背后的表格会在点击的半途换成加载状态、页面变短、滚动的位置随之收回；
// WebKit 接着按旧的滚动位置命中鼠标事件，确认弹窗里的那一下落到 <html> 上，什么都没发生（第三批 WebKit 上审计用例的偶发失败，
// 根因与探针见复核报告）。所以先等过滤之后的结果回来，再操作这一行。
import type { Page } from '@playwright/test'

/**
 * 在标签为 label 的搜索框里填 keyword，等到按它过滤的列表请求有了响应：之后表格里就是过滤之后的行。
 * 每次都要真的发出请求：在刚打开的页面上用（同一个页面里已经按同一个关键词搜过，就不会再请求）
 */
export async function searchList(page: Page, label: string, keyword: string): Promise<void> {
  const searched = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname.startsWith('/api/') && url.searchParams.get('query') === keyword && response.request().method() === 'GET'
  })
  await page.getByLabel(label, { exact: true }).fill(keyword)
  await searched
}
