// E2E 断言"没有页面错误"时，哪些 pageerror 不是应用的错误。每个用例都由夹具断言（fixtures.ts 的 pageErrors，M2-P6 第 6 片复核 S6）；
// 只读的用例另在过程中的检查点上断言（collectPageErrors，support/read-only.ts）。
// 排除的写法由 page-errors.test.ts 核对，WebKit 的取消请求另由 specs/foundation/page-errors.spec.ts 在真实的浏览器里核对。
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

/**
 * WebKit 在整页跳转时取消还在路上的请求，并自己往控制台打一条"Fetch API cannot load <地址> due to access control checks."。
 * Playwright 在 WebKit 上把来源为 javascript 的控制台错误一律当成页面错误，按第一个冒号拆成名称与说明、再跳过两个字符，
 * 所以名称是"Fetch API cannot load http"，说明是"/主机/路径 due to access control checks."（"://"被拆开了）。
 * 它不是应用的错误：同源的请求不会真的卡在跨域检查上；应用里真正没接住的拒绝，WebKit 报的是
 * "Unhandled Promise Rejection: TypeError: …"，照样算错误。2026-10-02 CI 的 WebKit 上出现（第 6 片合并之后，US-M2-07 的主链路
 * 在编辑器页刚打开、元数据与内容还在路上时就跳走）；本机反复打开编辑器页、不等加载完就跳走，WebKit 每次都报，Chromium 不报。
 * 只排除地址与报告时的页面同源（协议与主机都相同）的这一条，写法严格匹配
 */
const WEBKIT_CANCELLED_FETCH = /^\/([^/\s]+)(?:\/\S*)? due to access control checks\.$/

/** WebKit 取消同源请求的诊断（见 WEBKIT_CANCELLED_FETCH）；不知道页面的地址时不排除 */
function isCancelledSameOriginFetch(error: Pick<Error, 'name' | 'message'>, pageUrl: string | undefined): boolean {
  if (pageUrl === undefined || !URL.canParse(pageUrl))
    return false
  const page = new URL(pageUrl)
  if (error.name !== `Fetch API cannot load ${page.protocol.slice(0, -1)}`)
    return false
  return WEBKIT_CANCELLED_FETCH.exec(error.message)?.[1] === page.host
}

/**
 * 这条页面错误是浏览器的通知、不是应用的错误（见 RESIZE_OBSERVER_LOOP_NOTICE、WEBKIT_CANCELLED_FETCH）。
 * pageUrl 是报告时页面的地址，用来判断取消的请求是不是同源的
 */
export function isBrowserNotice(error: Pick<Error, 'name' | 'message'>, pageUrl: string | undefined): boolean {
  return RESIZE_OBSERVER_LOOP_NOTICE.test(error.message) || isCancelledSameOriginFetch(error, pageUrl)
}

/** 记下这个页面的错误（名称与说明），排除浏览器的通知 */
export function collectPageErrors(page: Page, into: string[]): void {
  page.on('pageerror', (error) => {
    if (!isBrowserNotice(error, page.url()))
      into.push(`${error.name}: ${error.message}`)
  })
}
