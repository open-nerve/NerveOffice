// 页面自检只把结果交给本机（M3-P2 复核 B7）：测试构建里，带着任意 next 打开自检的入口页或编辑器页，结果（文档 id、检查结果、
// 页面错误、公式算出的值）都不能被整页带到别处。next 不是本机的地址（http://127.0.0.1:<端口>、http://localhost:<端口>）时：
// - 入口页不登录、不跳转，原因写在页面上；地址里的 # 片段（测试账户的密码）照样马上从地址栏里去掉；
// - 编辑器页到 steady 之后不跑自检、不跳转，原因写在页面上；enter-exit 本来要改一格、保存，这份文档没有被改。
// 外面的地址由这里拦下并记下：一次也没有请求过。判断的规则（哪些算本机）由单元测试逐条核对（selftest-report.test.ts）。
// 用到测试构建（自检的入口页与编辑器页里的自检）：标签 @test-build，外部模式测生产镜像时排除
import type { Page } from '@playwright/test'
import { createDocument, createUser, revisionOf } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { selftestPageUrl } from '../../support/selftest-plan.ts'
import { loginThroughApi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 本机之外的收集端 */
const OUTSIDE = 'https://collector.example'

/** 页面上写出的原因 */
const NOT_LOCAL = `next 只能是本机的地址（http://127.0.0.1:<端口> 或 http://localhost:<端口>），这里是 ${OUTSIDE}`

/** 拦下并记下发往本机之外的收集端的请求（不应该有） */
async function watchOutside(page: Page): Promise<string[]> {
  const requested: string[] = []
  await page.route(`${OUTSIDE}/**`, async (route) => {
    requested.push(route.request().url())
    await route.abort()
  })
  return requested
}

test.describe('US-M2-11 页面自检只把结果交给本机（M3-P2 复核 B7）', { tag: '@test-build' }, () => {
  test('入口页：next 不是本机的地址时不登录、不跳转，原因写在页面上；片段里的账户照样从地址栏里去掉', async ({ page }) => {
    const author = await createUser('st-next-entry', '作者')
    const documentId = await createDocument(author, '表')
    const outside = await watchOutside(page)
    const logins: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/login')
        logins.push(request.method())
    })
    await page.goto(selftestPageUrl(e2eOrigin(), { id: 'next', scenario: 'enter-exit', account: author, documentId }, `${OUTSIDE}/report?step=next`))
    await expect(page.locator('#status')).toHaveText(`不登录、不跳转：${NOT_LOCAL}`)
    const url = new URL(page.url())
    expect([url.pathname, url.hash]).toEqual(['/selftest.html', ''])
    expect([logins, outside]).toEqual([[], []])
  })

  test('编辑器页：地址里的 next 不是本机的地址时，到 steady 之后不跑自检、不跳转，原因写在页面上；这份文档没有被改', async ({ page }) => {
    const author = await createUser('st-next-editor', '作者')
    const documentId = await createDocument(author, '表')
    const outside = await watchOutside(page)
    await loginThroughApi(page, author)
    const opened = `/documents/${documentId}?selftest=enter-exit&next=${encodeURIComponent(`${OUTSIDE}/report?step=next`)}`
    await page.goto(opened)
    await expect(page.getByRole('alert').filter({ hasText: '页面自检没有运行' })).toHaveText(`页面自检没有运行：${NOT_LOCAL}`, { timeout: 60_000 })
    const url = new URL(page.url())
    expect(`${url.pathname}${url.search}`).toBe(opened)
    expect(outside).toEqual([])
    expect(await revisionOf(documentId)).toBe(1)
  })
})
