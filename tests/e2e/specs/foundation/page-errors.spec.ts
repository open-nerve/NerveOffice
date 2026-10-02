// E2E 的页面错误夹具（support/fixtures.ts 的 pageErrors）在真实的浏览器里：页面里真正没接住的异常照样报出（排除浏览器的通知
// 不能排除过头）；整页跳转时还在路上的加载不留下页面错误（冒烟：WebKit 会打取消加载的诊断，被排除；碰不碰得上靠时机，
// 2026-10-02 CI 上 20 次跳转一次也没碰上，所以不断言它出现过——排除的写法与接线由 support/page-errors.test.ts 用 CI 日志里的原文核对）
import { createDocument, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 来回几次 */
const ROUNDS = 10

test.describe('E2E 的页面错误夹具', () => {
  test('整页跳转时还在路上的加载不留下页面错误；页面里真正没接住的拒绝照样报出', async ({ page, pageErrors }) => {
    pageErrors.expectErrors()
    const owner = await createUser('page-errors')
    const id = await createDocument(owner, '跳走')
    await loginThroughApi(page, owner)
    // 打开编辑器页、不等加载完就跳到平台页，再不等加载完就跳回去
    for (let round = 0; round < ROUNDS; round++) {
      await page.goto(`/documents/${id}`, { waitUntil: 'commit' })
      await page.goto('/', { waitUntil: 'commit' })
    }
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(pageErrors.list()).toEqual([])

    await page.evaluate(() => {
      void Promise.reject(new TypeError('夹具自测：没接住的拒绝'))
    })
    await expect.poll(() => pageErrors.list()).toEqual([expect.stringContaining('夹具自测：没接住的拒绝')])
  })
})
