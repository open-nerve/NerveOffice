// 真实离线编辑、公开退出界面与服务端；不依赖探针，生产节奏与容器也运行。
import type { TestUser } from '../../support/database.ts'
import { createUser, revisionOf } from '../../support/database.ts'
import { actualLocalDraft } from '../../support/draft-catalog.ts'
import { expect, test } from '../../support/fixtures.ts'
import { readLocalDisk } from '../../support/local-draft.ts'
import { openLogoutPreview } from '../../support/logout.ts'
import { loginThroughApi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test('退出先预览本人草稿；320px 键盘取消保留原件，明确确认后清理且云端不变', async ({ page }, testInfo) => {
  const h = await actualLocalDraft(page, '取消退出时必须保留的内容')
  await page.goto('/api/health/ready')
  const original = await readLocalDisk(page, h.key)
  let logouts = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/logout')
      logouts++
  })
  await page.setViewportSize({ width: 320, height: 740 })
  await openLogoutPreview(page)
  await expect(page.getByText(h.owner.displayName, { exact: true })).toBeVisible()
  await expect(page.getByText(h.title, { exact: true })).toBeVisible()
  await expect(page.getByText(/^本机时间：/)).toBeVisible()
  expect(await readLocalDisk(page, h.key)).toEqual(original)
  expect(logouts).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await testInfo.attach('320px-logout-preview', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  await page.getByRole('button', { name: '取消', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
  expect(await readLocalDisk(page, h.key)).toEqual(original)
  expect(logouts).toBe(0)
  expect((await page.request.get('/api/auth/session')).status()).toBe(200)
  await page.getByRole('button', { name: '退出', exact: true }).click()
  const confirm = page.getByRole('button', { name: '清理本机草稿并退出', exact: true })
  await confirm.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
  expect(logouts).toBe(1)
  expect(await readLocalDisk(page, h.key)).toEqual({ draft: null, writer: null })
  expect((await page.request.get('/api/auth/session')).status()).toBe(401)
  expect(await revisionOf(h.documentId)).toBe(1)
})

test('退出回包丢失分别显示两侧结果；只用原 CSRF 重试，原会话已结束也能收尾', async ({ page }) => {
  const h = await actualLocalDraft(page, '回包丢失时清理结果仍如实')
  const tokens: (string | undefined)[] = []
  await page.route('**/api/auth/logout', async (route) => {
    tokens.push(route.request().headers()['x-csrf-token'])
    const response = await route.fetch()
    expect(response.status()).toBe([204, 401][tokens.length - 1])
    if (tokens.length === 1) {
      await route.abort('failed')
    }
    else {
      await route.fulfill({ response })
    }
  })
  await openLogoutPreview(page)
  let sessionChecks = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/session')
      sessionChecks++
  })
  await page.getByRole('button', { name: '清理本机草稿并退出' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('尚未确认服务器上的登录是否结束，请检查网络后重试。')).toBeVisible()
  await expect(page.getByText('本机数据已清理。', { exact: true })).toBeVisible()
  await expect(page.getByText(h.title, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '退出登录' })).toBeFocused()
  expect(await readLocalDisk(page, h.key)).toEqual({ draft: null, writer: null })
  expect(sessionChecks).toBe(0)
  expect(tokens).toHaveLength(1)
  await page.getByRole('button', { name: '重试未完成步骤' }).click()
  await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
  expect(tokens).toHaveLength(2)
  expect(tokens[0]).toBeTruthy()
  expect(tokens[1]).toBe(tokens[0])
  expect(await revisionOf(h.documentId)).toBe(1)
})

for (const { account, next, titleCount } of [
  { account: '同一人', next: async (owner: TestUser) => owner, titleCount: 1 },
  { account: '其他人', next: async (_owner: TestUser) => createUser('logout-next', '当前账户'), titleCount: 0 },
]) {
  test(`退出预览后${account}重新登录：原确认失效，原件和新会话不受影响`, async ({ page, context }) => {
    const h = await actualLocalDraft(page, '旧确认不能删掉这份原件')
    await page.goto('/api/health/ready')
    const original = await readLocalDisk(page, h.key)
    await openLogoutPreview(page)
    let logouts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/logout')
        logouts++
    })
    const current = await next(h.owner)
    const other = await context.newPage()
    await loginThroughApi(other, current)
    await other.goto('/')
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    // 重新聚焦也核对原持久资格；不能依赖广播必达。
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByText('登录状态已经变化，这次退出已停止。请重新预览当前账户后再确认。')).toBeVisible()
    await expect(page.getByText(h.title, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '清理本机草稿并退出' })).toHaveCount(0)
    expect(await readLocalDisk(page, h.key)).toEqual(original)
    expect(logouts).toBe(0)
    const session = await page.request.get('/api/auth/session')
    expect(session.status()).toBe(200)
    expect((await session.json() as { user: { id: string } }).user.id).toBe(current.id)
    await page.getByRole('button', { name: '重新预览当前账户' }).click()
    await expect(page.getByRole('button', { name: '清理本机草稿并退出' })).toHaveAttribute('aria-disabled', 'false')
    await expect(page.getByText(current.displayName, { exact: true })).toBeVisible()
    await expect(page.getByText(h.title, { exact: true })).toHaveCount(titleCount)
    expect(logouts).toBe(0)
    expect(await readLocalDisk(page, h.key)).toEqual(original)
    await other.close()
  })
}
