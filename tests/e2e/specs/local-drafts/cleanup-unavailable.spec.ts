// 临时上下文也必须如实呈现清理失败；不把常规持久目录故事替换成对私密模式的成功承诺。
import { failMirrorRoot, localSessionPhase } from '../../support/cleanup-fault.ts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { openLogoutPreview } from '../../support/logout.ts'
import { loginThroughApi } from '../../support/session.ts'

test.use({ webkitStorage: 'temporary' })

test('临时上下文根目录不可读：服务器退出，本机保留未清完状态，用户可以前往登录', async ({ page }, testInfo) => {
  const owner = await createUser('cleanup-unavailable')
  await loginThroughApi(page, owner)
  await openLogoutPreview(page)
  const native = await page.evaluate(async () => {
    try {
      await navigator.storage.getDirectory()
      return { kind: 'opened' }
    }
    catch (error) {
      return { kind: 'failed', name: error instanceof DOMException ? error.name : 'Error' }
    }
  })
  await testInfo.attach('temporary-native-root', { body: JSON.stringify(native), contentType: 'application/json' })
  await failMirrorRoot(page, 'UnknownError')
  await page.getByRole('button', { name: '清理本机草稿并退出', exact: true }).click()
  await expect(page.getByText('服务器上的登录已结束。', { exact: true })).toBeVisible()
  await expect(page.getByText('本机数据清理失败，尚不能确认数据已清理。请检查浏览器存储后重试。', { exact: true })).toBeVisible()
  await expect(page.getByText('本机数据已清理。', { exact: true })).toHaveCount(0)
  expect(await localSessionPhase(page)).toBe('clearing')
  expect((await page.request.get('/api/auth/session')).status()).toBe(401)
  await page.getByRole('link', { name: '前往登录', exact: true }).click()
  await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
})
