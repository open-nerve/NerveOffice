// 所有用例共用的夹具：从这里引用 test 与 expect，而不是直接从 @playwright/test。
//
// CSP 违规的收集（审查 B1）：浏览器不一定把违规写进控制台（被 try/catch 接住的 new Function 探测，三个浏览器都不写），
// 只看控制台会漏掉。每个文档加载之前挂上 securitypolicyviolation 的监听，经绑定函数报给测试进程（跨整页跳转、多个标签页都不丢），
// 每个用例结束时断言一条违规都没有。另一台设备（anotherDevice）的浏览器上下文同样挂上，违规记进同一个列表（M2-P1 审查 B1）。
// 限制：Worker 里的违规在 Worker 自己的作用域触发，这里收不到（WebKit 也不上报，00 号计划书 §11.3），由阳性对照与产物扫描覆盖。
import type { BrowserContext, Page } from '@playwright/test'
import { test as base, expect } from '@playwright/test'

export interface CspViolation {
  /** 违反的指令，例如 script-src、connect-src */
  readonly directive: string
  readonly blockedUri: string
  /** 发生违规的页面 */
  readonly documentUri: string
  readonly sourceFile: string
  readonly line: number
  readonly sample: string
}

export interface CspViolations {
  /** 到目前为止收到的违规 */
  readonly list: () => readonly CspViolation[]
  /** 声明本用例预期有违规（CSP 阳性对照）：用例结束时不再断言为空，由用例自己检查收到的违规 */
  readonly expectViolations: () => void
  /** 本用例另开的浏览器上下文也收集，记进同一个列表（在它打开页面之前调用） */
  readonly watch: (context: BrowserContext) => Promise<void>
}

const REPORT_BINDING = '__nerveReportCspViolation'

/** 在页面里执行（addInitScript）：不能引用外面的变量，绑定函数的名称经参数传入 */
function listenForViolations(binding: string): void {
  document.addEventListener('securitypolicyviolation', (event) => {
    const report = (window as unknown as Record<string, ((violation: unknown) => Promise<void>) | undefined>)[binding]
    void report?.({
      directive: event.effectiveDirective,
      blockedUri: event.blockedURI,
      documentUri: event.documentURI,
      sourceFile: event.sourceFile,
      line: event.lineNumber,
      sample: event.sample,
    })
  })
}

/** 这个浏览器上下文里每个文档加载之前挂上监听，违规交给 report */
async function watchCspViolations(context: BrowserContext, report: (violation: CspViolation) => void): Promise<void> {
  await context.exposeBinding(REPORT_BINDING, (_source, violation: CspViolation) => {
    report(violation)
  })
  await context.addInitScript(listenForViolations, REPORT_BINDING)
}

export const test = base.extend<{ cspViolations: CspViolations, anotherDevice: Page }>({
  /**
   * 另一台设备（M2-P1）：新的浏览器上下文，Cookie 与本用例的页面不共用；沿用配置里的基础地址、证书与语言设置。
   * 用来验证"其他地方的登录被退出"等跨会话的行为；用例结束时关闭。
   * 同样收集 CSP 违规（审查 B1）。trace 与失败时的截图不用另做：测试运行器对用例里新建的每个上下文都开 trace，
   * 关闭上下文时给它的页面截图（Playwright 的 ArtifactsRecorder），按配置的 retain-on-failure、only-on-failure 保留
   */
  anotherDevice: async ({ browser, cspViolations }, provide, testInfo) => {
    const { baseURL, ignoreHTTPSErrors, locale, timezoneId } = testInfo.project.use
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors, locale, timezoneId })
    await cspViolations.watch(context)
    await provide(await context.newPage())
    await context.close()
  },
  cspViolations: [async ({ context }, use) => {
    const violations: CspViolation[] = []
    let expected = false
    const report = (violation: CspViolation) => {
      violations.push(violation)
    }
    await watchCspViolations(context, report)
    await use({
      list: () => [...violations],
      expectViolations: () => {
        expected = true
      },
      watch: async other => watchCspViolations(other, report),
    })
    if (!expected)
      expect(violations, '页面里出现了 CSP 违规').toEqual([])
  }, { auto: true }],
})

export { expect }
