// CSP 与安全头（P3，US-M1-09）：所有响应都带定稿的策略与安全头；页面与 Worker 两个作用域的阳性对照中，违规的请求被拦截。
// 表格编辑器（含公式 Worker）在策略下正常工作的部分在 specs/editor/csp.spec.ts（P4）。
// 安全头的用例只用生产构建里的文件，本机与外部两种运行方式都执行（外部模式经 Caddy 的 HTTPS，另核对 HSTS）；
// 阳性对照与对照要打开测试构建里的探针页（csp-probe.html），标签 @test-build：测生产镜像的外部模式按标签排除（P5 设计 §3.6，审查 B2）。
import type { Page } from '@playwright/test'
import type { TargetServer } from '../../support/servers.ts'
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { watchExternalRequests } from '../../support/external-requests.ts'
import { expect, test } from '../../support/fixtures.ts'
import { startControlServer, startTargetServer } from '../../support/servers.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, openReader } from '../../support/sheet.ts'

/** M0 定稿的策略（00 号计划书 §11.3），逐字比较 */
const CONTENT_SECURITY_POLICY = 'default-src \'self\'; img-src \'self\' data: blob:; connect-src \'self\'; font-src \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\'; worker-src \'self\'; frame-ancestors \'none\'; base-uri \'self\'; form-action \'self\''
/** 只在 HTTPS 请求上下发，不加 includeSubDomains（apps/api 的 security-headers.ts） */
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000'

const ALL_BLOCKED = { fetch: 'blocked', eval: 'blocked', function: 'blocked' }
const ALL_ALLOWED = { fetch: 'allowed', eval: 'allowed', function: 'allowed' }

async function probeResult(page: Page, url: string): Promise<unknown> {
  await page.goto(url)
  await expect(page.locator('body[data-probe="done"]')).toBeAttached()
  return JSON.parse(await page.locator('#result').innerText()) as unknown
}

test.describe('US-M1-09 CSP 与安全头', () => {
  test('页面、脚本、Worker 脚本、接口与错误响应都带定稿的 CSP 与安全头；经 HTTPS 访问时带 HSTS；不暴露应用与代理的软件', async ({ page, request }, testInfo) => {
    // 实际打开编辑器取得 Worker 请求，沿用打开编辑器用例的既定时限。
    test.setTimeout(EDITOR_TEST_TIMEOUT)
    const index = await request.get('/')
    const script = /src="(\/assets\/index-[\w-]+\.js)"/.exec(await index.text())?.[1]
    const editorPage = await request.get(`/documents/${randomUUID()}`)
    const editorScript = /src="(\/assets\/editor-[\w-]+\.js)"/.exec(await editorPage.text())?.[1] ?? ''
    expect(script).toBeDefined()
    expect(editorScript).not.toBe('')
    // 创建 Worker 的代码可被打包器移到共享模块；以正式阅读流程实际收到的响应定位，不能只扫描入口文件。
    const workers = new Map<string, number>()
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (url.origin === e2eOrigin() && /^\/assets\/formula\.worker-[\w-]+\.js$/.test(url.pathname))
        workers.set(url.pathname, response.status())
    })
    await loginThroughApi(page, await createUser('csp-headers'))
    await openReader(page, await createSheetThroughApi(page))
    expect(workers.size).toBe(1)
    expect([...workers.values()]).toEqual([200])
    // 外部模式经 Caddy 的 HTTPS：应用采信了代理转发的协议才会下发 HSTS
    const https = new URL(e2eOrigin()).protocol === 'https:'

    const paths = ['/', '/login', script ?? '', editorScript, ...workers.keys(), '/api/health/live', '/api/auth/session', '/assets/missing.js']
    for (const path of paths) {
      const headers = (await request.get(path)).headers()
      expect(headers['content-security-policy'], path).toBe(CONTENT_SECURITY_POLICY)
      expect(headers['x-content-type-options'], path).toBe('nosniff')
      expect(headers['x-frame-options'], path).toBe('DENY')
      expect(headers['referrer-policy'], path).toBe('no-referrer')
      expect(headers['strict-transport-security'], path).toBe(https ? STRICT_TRANSPORT_SECURITY : undefined)
      expect(headers['x-powered-by'], path).toBeUndefined()
      expect(headers.server, path).toBeUndefined()
      expect(headers.via, path).toBeUndefined()
    }
    await testInfo.attach('csp-response-paths', { body: JSON.stringify({ editorScript, workerPaths: [...workers.keys()], checkedPaths: paths }), contentType: 'application/json' })
  })

  test.describe('探针', { tag: '@test-build' }, () => {
    let target: TargetServer

    test.beforeEach(async () => {
      target = await startTargetServer()
    })

    test.afterEach(async () => {
      await target.close()
    })

    test('阳性对照：页面与 Worker 里违反策略的请求、eval 与 new Function 都被拦截', async ({ page, context, cspViolations, baseURL }, testInfo) => {
      // 本用例就是要触发违规：声明预期有违规，夹具不再断言为空
      cspViolations.expectViolations()
      // Q-09：顺带记下请求观察器是否看到被 connect-src 拦下的尝试（只记录事实，不作断言：随浏览器而异，见 external-requests.ts）
      const watcher = watchExternalRequests(context, baseURL ?? e2eOrigin())
      try {
        const result = await probeResult(page, `/csp-probe.html?target=${encodeURIComponent(`${target.origin}/probe`)}`)
        expect(result).toEqual({ page: ALL_BLOCKED, worker: ALL_BLOCKED })
        expect(target.hits()).toBe(0)
        // 夹具收到了页面里的违规（Worker 里的收不到）：证明所有用例共用的违规收集本身有效（审查 B1）
        await expect.poll(() => [...new Set(cspViolations.list().map(violation => violation.directive))].sort()).toEqual(['connect-src', 'script-src'])
      }
      finally {
        watcher.stop()
        await testInfo.attach('blocked-attempts-observed', { body: JSON.stringify({ observed: watcher.list(), targetHits: target.hits() }), contentType: 'application/json' })
      }
    })

    test('M5R-M-15 对照：以 /favicon.ico 结尾的站外地址，请求观察器看不到，只有目标服务的命中数能发现', async ({ page, context }, testInfo) => {
      const control = await startControlServer()
      const watcher = watchExternalRequests(context, control.origin)
      try {
        const result = await probeResult(page, `${control.origin}/csp-probe.html?target=${encodeURIComponent(`${target.origin}/probe/favicon.ico`)}`)
        expect(result).toEqual({ page: ALL_ALLOWED, worker: ALL_ALLOWED })
        // 网络侧真值：页面与 Worker 各取到一次
        expect(target.requests()).toEqual(['/probe/favicon.ico', '/probe/favicon.ico'])
        // Playwright 不为这类地址发出 context 的请求事件：只看观察器会平凡通过，所以关键样本另以目标服务零命中为准
        expect(watcher.list()).toEqual([])
      }
      finally {
        watcher.stop()
        await control.close()
        await testInfo.attach('favicon-observer-control', { body: JSON.stringify({ observed: watcher.list(), targetRequests: target.requests() }), contentType: 'application/json' })
      }
    })

    test('US-M5-14 对照：无 CSP 探针有效且请求观察覆盖页面、Worker 与新页', async ({ page, context }, testInfo) => {
      const control = await startControlServer()
      const watcher = watchExternalRequests(context, control.origin)
      try {
        const result = await probeResult(page, `${control.origin}/csp-probe.html?target=${encodeURIComponent(`${target.origin}/probe`)}`)
        expect(result).toEqual({ page: ALL_ALLOWED, worker: ALL_ALLOWED })
        expect(target.hits()).toBe(2)
        expect(watcher.list()).toEqual([`${target.origin}/probe`, `${target.origin}/probe`])
        const another = await context.newPage()
        try {
          await another.goto(`${target.origin}/new-page`)
          expect(watcher.list()).toEqual([`${target.origin}/probe`, `${target.origin}/probe`, `${target.origin}/new-page`])
          expect(target.hits()).toBe(3)
        }
        finally {
          await another.close()
        }
      }
      finally {
        watcher.stop()
        await control.close()
        await testInfo.attach('request-observer-control', { body: JSON.stringify({ requests: watcher.list(), targetHits: target.hits(), targetRequests: target.requests() }), contentType: 'application/json' })
      }
    })
  })
})
