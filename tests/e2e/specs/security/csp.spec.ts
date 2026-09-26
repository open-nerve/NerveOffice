// CSP 与安全头（P3，US-M1-09）：所有响应都带定稿的策略；页面与 Worker 两个作用域的阳性对照中，违规的请求被拦截。
// 表格编辑器（含公式 Worker）在策略下正常工作的部分随 P4 的编辑器页补上。
import type { Page } from '@playwright/test'
import type { LocalServer } from '../../support/servers.ts'
import { expect, test } from '@playwright/test'
import { startControlServer, startTargetServer } from '../../support/servers.ts'

/** M0 定稿的策略（00 号计划书 §11.3），逐字比较 */
const CONTENT_SECURITY_POLICY = 'default-src \'self\'; img-src \'self\' data: blob:; connect-src \'self\'; font-src \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\'; worker-src \'self\'; frame-ancestors \'none\'; base-uri \'self\'; form-action \'self\''

const ALL_BLOCKED = { fetch: 'blocked', eval: 'blocked', function: 'blocked' }
const ALL_ALLOWED = { fetch: 'allowed', eval: 'allowed', function: 'allowed' }

let target: LocalServer

test.beforeEach(async () => {
  target = await startTargetServer()
})

test.afterEach(async () => {
  await target.close()
})

async function probeResult(page: Page, url: string): Promise<unknown> {
  await page.goto(url)
  await expect(page.locator('body[data-probe="done"]')).toBeAttached()
  return JSON.parse(await page.locator('#result').innerText()) as unknown
}

test.describe('US-M1-09 CSP 与安全头', () => {
  test('HTML、脚本、Worker 脚本、接口与错误响应都带定稿的 CSP 与安全头', async ({ request }) => {
    const index = await request.get('/')
    const script = /src="(\/assets\/index-[\w-]+\.js)"/.exec(await index.text())?.[1]
    const probePage = await request.get('/csp-probe.html')
    const probeScript = /src="(\/assets\/csp-probe-[\w-]+\.js)"/.exec(await probePage.text())?.[1] ?? ''
    const worker = /\/assets\/probe-worker-[\w-]+\.js/.exec(await (await request.get(probeScript)).text())?.[0]
    expect(script).toBeDefined()
    expect(worker).toBeDefined()

    for (const path of ['/', '/login', script ?? '', worker ?? '', '/api/health/live', '/api/auth/session', '/assets/missing.js']) {
      const response = await request.get(path)
      const headers = response.headers()
      expect(headers['content-security-policy'], path).toBe(CONTENT_SECURITY_POLICY)
      expect(headers['x-content-type-options'], path).toBe('nosniff')
      expect(headers['x-frame-options'], path).toBe('DENY')
      expect(headers['referrer-policy'], path).toBe('no-referrer')
    }
  })

  test('阳性对照：页面与 Worker 里违反策略的请求、eval 与 new Function 都被拦截', async ({ page }) => {
    const result = await probeResult(page, `/csp-probe.html?target=${encodeURIComponent(`${target.origin}/probe`)}`)
    expect(result).toEqual({ page: ALL_BLOCKED, worker: ALL_BLOCKED })
    expect(target.hits()).toBe(0)
  })

  test('对照：没有 CSP 时同样的探针都能执行（探针有效，目标可达）', async ({ page }) => {
    const control = await startControlServer()
    try {
      const result = await probeResult(page, `${control.origin}/csp-probe.html?target=${encodeURIComponent(`${target.origin}/probe`)}`)
      expect(result).toEqual({ page: ALL_ALLOWED, worker: ALL_ALLOWED })
      expect(target.hits()).toBe(2)
    }
    finally {
      await control.close()
    }
  })
})
