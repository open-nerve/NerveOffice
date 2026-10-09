// 持久化的浏览器目录（M4-P1 设计 §1 偏差 7）：Playwright 默认的浏览器上下文不落盘——Chromium 是无痕式的上下文、WebKit 用临时的数据存储，
// IndexedDB 在内存里；M0 的写入耗时、strict 的开销与写满都是在那上面测的。关于落盘、配额与写入耗时的测量（S1 的写满与本机的实测）
// 在这里开的持久上下文里做。只开、关一个持久上下文并挂上夹具的收集（CSP 违规、页面错误），另有 Chromium 系经 CDP 的两样：覆盖配额、
// 造出"已授予持久保存"。结束整棵浏览器进程、以同一个目录重开的崩溃工具是另一件事（S7），资料目录同样经这里的 profileDirFor 取。
// 资料目录的路径里不能有非 ASCII 的字符：Linux 上 Playwright 的 WebKit（WPE 的 MiniBrowser）解析命令行时遇到就起不来（"Cannot parse arguments:
// Invalid byte sequence in conversion input"，与区域设置无关：官方镜像的 C.UTF-8 下一样，P1 审查 B1 复现）——testInfo.outputPath 带着中文的
// 用例标题，所以持久上下文一律不用它
import type { BrowserContext, BrowserType, Page, TestInfo } from '@playwright/test'
import type { CspViolations, PageErrors } from './fixtures.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 用例的夹具：另开的上下文同样挂上 CSP 违规与页面错误的收集 */
export interface ProfileWatchers {
  readonly cspViolations: CspViolations
  readonly pageErrors: PageErrors
}

/** 资料目录放在项目输出目录下的这个子目录里 */
export const PROFILES_DIR_NAME = 'persistent-profiles'

/**
 * 资料目录的名字：<用例的 id>-<第几次重复>-<第几次重试>-<name>，只有 ASCII（用例的 id 是十六进制；name 只许字母、数字与连字符，
 * 不合时抛出——免得又把非 ASCII 的字带进 WebKit 的命令行）
 */
export function profileDirName(testId: string, repeatEachIndex: number, retry: number, name: string): string {
  if (!/^[\w-]+$/.test(testId))
    throw new Error(`用例的 id 不是 ASCII 的字母、数字与连字符：${testId}`)
  if (!/^[a-z0-9-]+$/i.test(name))
    throw new Error(`资料目录的名字只许 ASCII 的字母、数字与连字符：${name}`)
  return `${testId}-${repeatEachIndex}-${retry}-${name}`
}

/**
 * 持久上下文的资料目录：<项目的输出目录>/persistent-profiles/<用例的 id>-<第几次重复>-<第几次重试>-<name>。每条用例、每次重复与重试、
 * 每个 name 各自一个；建好目录，路径记进用例的注解（persistent-profile）；失败时留着便于看，下一次运行 Playwright 清空项目的输出目录。
 * 不带用例标题（见文件开头）；仓库本身放在带非 ASCII 字符的路径下时照样起不来，那是环境的事
 */
export function profileDirFor(testInfo: TestInfo, name: string): string {
  const dir = join(testInfo.project.outputDir, PROFILES_DIR_NAME, profileDirName(testInfo.testId, testInfo.repeatEachIndex, testInfo.retry, name))
  mkdirSync(dir, { recursive: true })
  testInfo.annotations.push({ type: 'persistent-profile', description: dir })
  return dir
}

/**
 * 以 profileDirFor(testInfo, name) 为资料目录，开一个持久上下文：沿用这个项目的浏览器（channel）、基础地址、语言与时区、证书设置
 * （与夹具的上下文相同）
 */
export async function launchPersistentProfile(browserType: BrowserType, testInfo: TestInfo, name: string, watchers: ProfileWatchers): Promise<BrowserContext> {
  const { baseURL, locale, timezoneId, ignoreHTTPSErrors, channel } = testInfo.project.use
  const context = await browserType.launchPersistentContext(profileDirFor(testInfo, name), { channel, baseURL, locale, timezoneId, ignoreHTTPSErrors })
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
