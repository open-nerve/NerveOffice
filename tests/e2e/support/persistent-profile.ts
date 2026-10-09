// 持久化的浏览器目录（M4-P1 设计 §1 偏差 7）：Playwright 默认的浏览器上下文不落盘——Chromium 是无痕式的上下文、WebKit 用临时的数据存储，
// IndexedDB 在内存里；M0 的写入耗时、strict 的开销与写满都是在那上面测的。关于落盘、配额与写入耗时的测量（S1 的写满与本机的实测）
// 在这里开的持久上下文里做。只开、关一个持久上下文并挂上夹具的收集（CSP 违规、页面错误），另有 Chromium 系经 CDP 的两样：覆盖配额、
// 造出"已授予持久保存"。结束整棵浏览器进程、以同一个目录重开的崩溃工具是另一件事（S7）
import type { BrowserContext, BrowserType, Page, TestInfo } from '@playwright/test'
import type { CspViolations, PageErrors } from './fixtures.ts'

/** 用例的夹具：另开的上下文同样挂上 CSP 违规与页面错误的收集 */
export interface ProfileWatchers {
  readonly cspViolations: CspViolations
  readonly pageErrors: PageErrors
}

/**
 * 以测试输出目录下的 name 为资料目录，开一个持久上下文：沿用这个项目的浏览器（channel）、基础地址、语言与时区、证书设置（与夹具的上下文相同）。
 * 资料目录在 testInfo.outputPath 里：每条用例、每次重试各自一个，下一次运行 Playwright 清空它
 */
export async function launchPersistentProfile(browserType: BrowserType, testInfo: TestInfo, name: string, watchers: ProfileWatchers): Promise<BrowserContext> {
  const { baseURL, locale, timezoneId, ignoreHTTPSErrors, channel } = testInfo.project.use
  const context = await browserType.launchPersistentContext(testInfo.outputPath(name), { channel, baseURL, locale, timezoneId, ignoreHTTPSErrors })
  await watchers.cspViolations.watch(context)
  watchers.pageErrors.watch(context)
  return context
}

/** 持久上下文开着时自带的那一页（没有就新开一页） */
export async function firstPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? context.newPage()
}

/**
 * CDP 的覆盖随会话：会话断开时浏览器撤掉它（配额的覆盖与权限的覆盖都是；2026-10-09 实测，先断开会话的那一版覆盖从没生效）。
 * 交回撤掉的办法（断开会话），用完再调
 */
export type ReleaseOverride = () => Promise<void>

/**
 * Chromium 系经 CDP 把这个源的配额覆盖成 bytes。要在这个源第一次写 IndexedDB 之前设（M0-P6 审查 S3）：编辑器页一载入 Univer 就建它自己的库，
 * 所以先打开同源里不写存储的一页（健康检查的接口）再设。页面里看不出覆盖了没有：estimate() 照旧报真实的配额（M0-P6 与这里的实测相同）
 */
export async function overrideQuota(context: BrowserContext, page: Page, origin: string, bytes: number): Promise<ReleaseOverride> {
  await page.goto(`${origin}/api/health/ready`)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: bytes })
  return async () => cdp.detach()
}

/** Chromium 系经 CDP 造出这个源"已授予持久保存"（durableStorage：之后 persist() 与 persisted() 为真；真实用户的 Chrome 按书签、安装、参与度授予） */
export async function grantDurableStorage(context: BrowserContext, page: Page, origin: string): Promise<ReleaseOverride> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Browser.grantPermissions', { origin, permissions: ['durableStorage'] })
  return async () => cdp.detach()
}
