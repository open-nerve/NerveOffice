// 所有用例共用的夹具：从这里引用 test 与 expect，而不是直接从 @playwright/test。
//
// CSP 违规的收集（审查 B1）：浏览器不一定把违规写进控制台（被 try/catch 接住的 new Function 探测，三个浏览器都不写），
// 只看控制台会漏掉。每个文档加载之前挂上 securitypolicyviolation 的监听，经绑定函数报给测试进程（跨整页跳转、多个标签页都不丢），
// 每个用例结束时断言一条违规都没有。
// 限制：Worker 里的违规在 Worker 自己的作用域触发，这里收不到（WebKit 也不上报，00 号计划书 §11.3），由阳性对照与产物扫描覆盖。
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

export const test = base.extend<{ cspViolations: CspViolations }>({
  cspViolations: [async ({ context }, use) => {
    const violations: CspViolation[] = []
    let expected = false
    await context.exposeBinding(REPORT_BINDING, (_source, violation: CspViolation) => {
      violations.push(violation)
    })
    await context.addInitScript(listenForViolations, REPORT_BINDING)
    await use({
      list: () => [...violations],
      expectViolations: () => {
        expected = true
      },
    })
    if (!expected)
      expect(violations, '页面里出现了 CSP 违规').toEqual([])
  }, { auto: true }],
})

export { expect }
