// E2E 的页面错误夹具自测（support/fixtures.ts 的 pageErrors，M2-P6 第 6 片合并之后的 CI）：浏览器自己的诊断不算页面错误，
// 页面里真正没接住的异常照样算。WebKit 在整页跳转时取消还在路上的请求，会往控制台打"Fetch API cannot load … due to access control checks."，
// Playwright 把它当成页面错误（support/page-errors.ts）。这里构造这种跳转，核对它被排除；WebKit 上要确实出现过这条诊断，
// 免得排除的那条路径没走到也通过——哪天 WebKit 不再报它，这里会失败，排除也就该删了
import type { Page } from '@playwright/test'
import type { PageErrors } from '../../support/fixtures.ts'
import { createDocument, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 这种跳转下会不会报取消请求的诊断：WebKit 报；Chromium 一系（含 Chrome、Edge）不报 */
const REPORTS_CANCELLED_FETCH: Readonly<Record<string, boolean>> = { webkit: true, chromium: false }
/** 最多来回几次：本机上 WebKit 第一次跳走就报，CI 慢，多留几次；不报的浏览器来回这么多次 */
const MAX_ROUNDS = 20

function cancelledFetches(pageErrors: PageErrors): number {
  return pageErrors.ignored().filter(notice => notice.startsWith('Fetch API cannot load')).length
}

/**
 * 打开编辑器页、不等加载完就跳到平台页，再不等加载完就跳回去：会话、元数据与内容的请求还在路上。
 * 会报诊断的浏览器出现一次就停
 */
async function navigateAwayWhileLoading(page: Page, documentId: string, pageErrors: PageErrors, reports: boolean): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (reports && cancelledFetches(pageErrors) > 0)
      return
    await page.goto(`/documents/${documentId}`, { waitUntil: 'commit' })
    await page.goto('/', { waitUntil: 'commit' })
  }
}

test.describe('E2E 的页面错误夹具', () => {
  test('整页跳转时还在路上的同源请求：WebKit 取消请求的诊断不算页面错误；真正没接住的拒绝照样算', async ({ page, pageErrors, browserName }) => {
    test.setTimeout(120_000)
    pageErrors.expectErrors()
    const reports = REPORTS_CANCELLED_FETCH[browserName] ?? false
    const owner = await createUser('page-errors')
    const id = await createDocument(owner, '跳走')
    await loginThroughApi(page, owner)
    await navigateAwayWhileLoading(page, id, pageErrors, reports)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(pageErrors.list()).toEqual([])
    expect(cancelledFetches(pageErrors) > 0, '取消请求的诊断出现过（WebKit 上排除的路径走到了；别的浏览器不报）').toBe(reports)

    await page.evaluate(() => {
      void Promise.reject(new TypeError('夹具自测：没接住的拒绝'))
    })
    await expect.poll(() => pageErrors.list()).toEqual([expect.stringContaining('夹具自测：没接住的拒绝')])
  })
})
