// 真实请求仍在途时离开：分别覆盖正文与公式 Worker；真正没接住的拒绝仍须报出。
// commit 只表示新文档已提交，紧接着反复 goto 会与浏览器自己的初始化相撞；现在按实际请求和目标页就绪同步。
import type { Page, Request } from '@playwright/test'
import { createDocument, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

function pending<T>(): { readonly promise: Promise<T>, readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function cancelledLoad(page: Page, request: Request, browserName: string): Promise<void> {
  // Chromium 丢弃尚停在 route 的旧页请求时不发 requestfailed；WebKit 会发，也正是需要过滤通知的浏览器。
  // 两边都已收到真实请求且尚未放行；WebKit 另核对该请求确实被这次导航取消。
  if (browserName !== 'webkit')
    return
  await page.waitForEvent('requestfailed', candidate => candidate === request)
  expect(request.failure(), request.url()).not.toBeNull()
}

test.describe('E2E 的页面错误夹具', () => {
  test('整页跳转时还在路上的加载不留下页面错误；页面里真正没接住的拒绝照样报出', async ({ page, pageErrors, browserName }) => {
    pageErrors.expectErrors()
    const owner = await createUser('page-errors')
    const id = await createDocument(owner, '跳走')
    await loginThroughApi(page, owner)
    for (const resource of [`**/api/documents/${id}/content`, '**/assets/formula.worker-*.js']) {
      const reached = pending<Request>()
      const released = pending<void>()
      const finished = pending<void>()
      await page.route(resource, async (route) => {
        reached.resolve(route.request())
        await released.promise
        try {
          await route.continue()
        }
        finally {
          finished.resolve()
        }
      }, { times: 1 })
      try {
        await page.goto(`/documents/${id}`, { waitUntil: 'domcontentloaded' })
        const request = await reached.promise
        const cancelled = cancelledLoad(page, request, browserName)
        await page.goto('/')
        released.resolve()
        await cancelled
        await finished.promise
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        expect(pageErrors.list()).toEqual([])
      }
      finally {
        released.resolve()
      }
    }

    await page.evaluate(() => {
      void Promise.reject(new TypeError('夹具自测：没接住的拒绝'))
    })
    await expect.poll(() => pageErrors.list()).toEqual([expect.stringContaining('夹具自测：没接住的拒绝')])
  })
})
