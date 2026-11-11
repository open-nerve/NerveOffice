// 浏览器真实回到在线的次数（M5-P8 托管 Mac 第 5 轮之后，需求方 2026-11-11 决定）。托管虚拟机上浏览器曾真实离线约 3～5 秒又恢复
// （navigator.onLine），页面回到在线时按 P2-S2 规格重新读取失败的图片（"联网恢复"创建新代）。用例要把这一次读取与自动循环请求分开，
// 就要知道期间浏览器回到在线了几次。
// 记数的脚本在页面自己的脚本之前装上（addInitScript），听的是与页面的连接监视（apps/web 的 shared/lib/browser-connection.ts）
// 同一对 online、offline 事件，按 navigator.onLine 的真实变化记"由离线回到在线"。同一目标上的监听按登记的先后执行：页面因回到在线
// 发出的请求之前，这里已经记下。每次载入页面（导航、刷新）重新从 0 记起
import type { Page } from '@playwright/test'

declare global {
  interface Window {
    /** 只在调用了 countBrowserReturns 的用例里有：这次载入以来浏览器由离线回到在线的次数 */
    __e2eBrowserReturns?: () => number
  }
}

/** 之后每次载入的页面都记下浏览器由离线回到在线的次数（在打开页面之前调用） */
export async function countBrowserReturns(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let online = navigator.onLine
    let returns = 0
    const note = (): void => {
      const next = navigator.onLine
      if (next && !online)
        returns += 1
      online = next
    }
    window.addEventListener('online', note)
    window.addEventListener('offline', note)
    Object.defineProperty(window, '__e2eBrowserReturns', { value: () => returns })
  })
}

/** 这次载入以来浏览器由离线回到在线的次数；没有装上记数的脚本时失败，不当作 0 */
export async function browserReturns(page: Page): Promise<number> {
  return page.evaluate(() => {
    const read = window.__e2eBrowserReturns
    if (read === undefined)
      throw new Error('页面里没有记录浏览器回到在线的脚本：打开页面之前先调用 countBrowserReturns')
    return read()
  })
}
