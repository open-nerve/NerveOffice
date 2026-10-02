// E2E 断言"没有页面错误"时，哪些 pageerror 不是应用的错误，以及按浏览器上下文收集页面错误的接线。每个用例都由夹具断言
// （fixtures.ts 的 pageErrors，M2-P6 第 6 片复核 S6）；只读的用例另在过程中的检查点上断言（collectPageErrors，support/read-only.ts）。
// 排除的写法与接线由 page-errors.test.ts 核对（用 CI 日志里的原文）。
import type { BrowserContext, Page } from '@playwright/test'

/**
 * 浏览器按 ResizeObserver 规范报告的"这一帧还有没送达的尺寸变化通知"：WebKit 与 Firefox 写作
 * "ResizeObserver loop completed with undelivered notifications."，Chromium 写作 "ResizeObserver loop limit exceeded"。
 * 规范要求把它作为一个错误事件报给 window（没有错误对象，Playwright 的 pageerror 里名称为空），但它不是应用的错误：
 * 回调里又改了被观察元素的尺寸时，没送达的通知在下一帧照常送达。Univer 的画布随容器调整尺寸
 * （engine-render 的 engine.ts 用 ResizeObserver），在慢的机器上偶尔出现（2026-10-01 CI 的 WebKit，本机三种浏览器都没有）。
 * 只排除这一条，写法严格匹配；别的页面错误一律算错误
 */
const RESIZE_OBSERVER_LOOP_NOTICE = /^ResizeObserver loop (?:completed with undelivered notifications\.?|limit exceeded)$/

/**
 * WebKit 在整页跳转时取消还在路上的加载，并自己往控制台打一条"… cannot load <地址> due to access control checks."。
 * Playwright 在 WebKit 上把来源为 javascript 的控制台错误一律当成页面错误，按第一个冒号拆成名称与说明、再跳过两个字符，
 * 所以名称是"… load http"，说明是"/主机/路径 due to access control checks."（"://"被拆开了）。见到过两种写法（2026-10-02 CI 的 WebKit，
 * US-M2-07 的主链路在编辑器页刚打开时就跳走）：fetch 的"Fetch API cannot load"（文档的元数据与内容），子资源的"Cannot load"
 * （公式 Worker 的脚本）。本机（macOS 的 WebKit）反复打开编辑器页、不等加载完就跳走，fetch 那种每次都有；Chromium 不报。
 * 它不是应用的错误：同源的加载不会真的卡在跨域检查上；应用里真正没接住的拒绝，WebKit 报的是"Unhandled Promise Rejection: …"，
 * 照样算错误。只排除这两种写法、地址与报告时的页面同源（协议与主机都相同）的，严格匹配
 */
const WEBKIT_CANCELLED_LOAD = /^\/([^/\s]+)(?:\/\S*)? due to access control checks\.$/
const WEBKIT_LOADERS = ['Fetch API cannot load', 'Cannot load'] as const

/** WebKit 取消同源加载的诊断（见 WEBKIT_CANCELLED_LOAD）；不知道页面的地址时不排除 */
function isCancelledSameOriginLoad(error: Pick<Error, 'name' | 'message'>, pageUrl: string | undefined): boolean {
  if (pageUrl === undefined || !URL.canParse(pageUrl))
    return false
  const page = new URL(pageUrl)
  const scheme = page.protocol.slice(0, -1)
  if (!WEBKIT_LOADERS.some(loader => error.name === `${loader} ${scheme}`))
    return false
  return WEBKIT_CANCELLED_LOAD.exec(error.message)?.[1] === page.host
}

/**
 * 这条页面错误是浏览器的通知、不是应用的错误（见 RESIZE_OBSERVER_LOOP_NOTICE、WEBKIT_CANCELLED_LOAD）。
 * pageUrl 是报告时页面的地址，用来判断取消的加载是不是同源的
 */
export function isBrowserNotice(error: Pick<Error, 'name' | 'message'>, pageUrl: string | undefined): boolean {
  return RESIZE_OBSERVER_LOOP_NOTICE.test(error.message) || isCancelledSameOriginLoad(error, pageUrl)
}

/**
 * 这个浏览器上下文里任何页面没接住的异常交给 report，浏览器的通知交给 ignore（"名称: 说明（页面的地址）"）。
 * 判断同源用报告时页面的地址；页面已经关了的，不知道地址，一律交给 report
 */
export function watchPageErrors(context: Pick<BrowserContext, 'on'>, report: (error: string) => void, ignore: (notice: string) => void): void {
  context.on('weberror', (webError) => {
    const error = webError.error()
    const pageUrl = webError.page()?.url()
    const text = `${error.name}: ${error.message}（${pageUrl ?? '页面已关闭'}）`
    if (isBrowserNotice(error, pageUrl))
      ignore(text)
    else
      report(text)
  })
}

/** 记下这个页面的错误（名称与说明），排除浏览器的通知 */
export function collectPageErrors(page: Page, into: string[]): void {
  page.on('pageerror', (error) => {
    if (!isBrowserNotice(error, page.url()))
      into.push(`${error.name}: ${error.message}`)
  })
}
