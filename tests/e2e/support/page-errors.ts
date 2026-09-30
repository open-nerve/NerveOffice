// E2E 断言"没有页面错误"时，哪些 pageerror 不是应用的错误。
import type { Page } from '@playwright/test'

/**
 * 浏览器按 ResizeObserver 规范报告的"这一帧还有没送达的尺寸变化通知"：WebKit 与 Firefox 写作
 * "ResizeObserver loop completed with undelivered notifications."，Chromium 写作 "ResizeObserver loop limit exceeded"。
 * 规范要求把它作为一个错误事件报给 window（没有错误对象，Playwright 的 pageerror 里名称为空），但它不是应用的错误：
 * 回调里又改了被观察元素的尺寸时，没送达的通知在下一帧照常送达。Univer 的画布随容器调整尺寸
 * （engine-render 的 engine.ts 用 ResizeObserver），在慢的机器上偶尔出现（2026-10-01 CI 的 WebKit，本机三种浏览器都没有）。
 * 只排除这一条，写法严格匹配；别的页面错误一律算错误
 */
const RESIZE_OBSERVER_LOOP_NOTICE = /^ResizeObserver loop (?:completed with undelivered notifications\.?|limit exceeded)$/

/** 这条页面错误是浏览器的通知、不是应用的错误（见 RESIZE_OBSERVER_LOOP_NOTICE；只看说明，各浏览器给的名称不一） */
export function isBrowserNotice(error: Error): boolean {
  return RESIZE_OBSERVER_LOOP_NOTICE.test(error.message)
}

/** 记下这个页面的错误（名称与说明），排除浏览器的通知 */
export function collectPageErrors(page: Page, into: string[]): void {
  page.on('pageerror', (error) => {
    if (!isBrowserNotice(error))
      into.push(`${error.name}: ${error.message}`)
  })
}
