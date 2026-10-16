// 完整清单使用真实存储/SDK 界面，不依赖测试构建探针；容器和生产节奏也运行。
import type { Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { captureRejection } from '../../support/auth-rejection.ts'
import { mirrorDigests } from '../../support/cleanup-fault.ts'
import { createUser, revisionOf } from '../../support/database.ts'
import { actualLocalDraft } from '../../support/draft-catalog.ts'
import { chooseAutosave, expect, test } from '../../support/fixtures.ts'
import { holdLegacyDatabase, legacyDatabaseKeys, remainingLegacyKeys, sawLegacyDeletion, seedLegacyDatabase, seedLegacyKeys, UNRELATED_DB } from '../../support/legacy-storage.ts'
import { readLocalDisk } from '../../support/local-draft.ts'
import { openLogoutPreview } from '../../support/logout.ts'
import { firstPage, launchPersistentProfile } from '../../support/persistent-profile.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, reloadAndEnterEditing, ribbon, saveAndWait, savedContent, selectCell, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const PENDING = '本机数据尚未全部清理。请关闭其它正在使用本站的标签页后重试。'
const REMAINING = { local: ['nerve-office:pending-save:other-user:original', 'unrelated-key'], session: ['nerve-office:pending-save:other-user:original'] }

async function openCustomFormat(page: Page) {
  const start = await ribbon(page, '开始')
  await start.locator('[data-u-command="sheet.operation.open.numfmt.panel"]').filter({ visible: true }).click()
  await page.getByText('更多格式', { exact: true }).filter({ visible: true }).click()
  const sidebar = page.getByRole('complementary', { name: '侧边栏' })
  await sidebar.getByText('常规', { exact: true }).click()
  await page.getByText('自定义格式', { exact: true }).filter({ visible: true }).click()
  await expect(sidebar.getByPlaceholder('自定义格式', { exact: true })).toBeVisible()
  return sidebar
}

test('US-M4-08 SDK 数字格式偏好仅在本次编辑器内保留，重建后不继承、不新增持久偏好', async ({ page }) => {
  await loginThroughApi(page, await createUser('sdk-memory'))
  const documentId = await createSheetThroughApi(page)
  await page.goto('/api/health/ready')
  await seedLegacyDatabase(page)
  await openAndEnterEditing(page, documentId, 'steady')
  await typeInCell(page, 'A1', '12')
  // 先完成这次输入，避免连续点同一单元格被 SDK 识别成双击，重新进入输入态而禁用格式菜单。
  await saveAndWait(page)
  await selectCell(page, 'A1')
  const format = '0.000000000000000'
  const sidebar = await openCustomFormat(page)
  await sidebar.getByPlaceholder('自定义格式', { exact: true }).fill(format)
  await sidebar.getByRole('button', { name: '确认', exact: true }).click()
  await expect(sidebar).toHaveCount(0)
  await saveAndWait(page)
  expect(JSON.stringify((await savedContent(page, documentId)).snapshot)).toContain(format)
  await selectCell(page, 'B1')
  const sameEditor = await openCustomFormat(page)
  await expect(sameEditor.getByText(format, { exact: true })).toBeVisible()
  expect(await legacyDatabaseKeys(page)).toEqual(['legacy-before'])
  expect((await remainingLegacyKeys(page)).local).toEqual([])
  await sameEditor.getByRole('button', { name: '取消', exact: true }).click()
  await reloadAndEnterEditing(page, 'steady')
  await selectCell(page, 'B1')
  const rebuilt = await openCustomFormat(page)
  await expect(rebuilt.getByText(format, { exact: true })).toHaveCount(0)
  expect(await legacyDatabaseKeys(page)).toEqual(['legacy-before'])
  expect((await remainingLegacyKeys(page)).local).toEqual([])
})

test('US-M4-08 确认退出清理本人草稿、镜像、旧库和全部记号，保留他人新键及无关数据库', async ({ playwright, browserName, cspViolations, pageErrors, autosave }, testInfo) => {
  // WebKit 临时上下文的 OPFS 根可能不可读；完整镜像清单在真正落盘的上下文中验证。
  const context = await launchPersistentProfile(playwright[browserName], testInfo, 'logout-all-storage', { cspViolations, pageErrors })
  await chooseAutosave(context, autosave)
  const page = await firstPage(context)
  try {
    const h = await actualLocalDraft(page, '完整退出清单')
    await openLogoutPreview(page)
    await seedLegacyKeys(page, h.owner.id)
    await seedLegacyDatabase(page)
    await seedLegacyDatabase(page, UNRELATED_DB)
    expect((await readLocalDisk(page, h.key)).draft).not.toBeNull()
    expect((await mirrorDigests(page, h.key)).length).toBeGreaterThan(0)
    await page.getByRole('button', { name: '清理本机草稿并退出', exact: true }).click()
    await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
    expect(await remainingLegacyKeys(page)).toEqual(REMAINING)
    expect(await legacyDatabaseKeys(page)).toBeNull()
    expect(await legacyDatabaseKeys(page, UNRELATED_DB)).toEqual(['legacy-before'])
    expect(await readLocalDisk(page, h.key)).toEqual({ draft: null, writer: null })
    expect(await mirrorDigests(page, h.key)).toEqual([])
    expect((await page.request.get('/api/auth/session')).status()).toBe(401)
    expect(await revisionOf(h.documentId)).toBe(1)
  }
  finally {
    await context.close()
  }
})

async function blockedLogout(page: Page) {
  const h = await actualLocalDraft(page, '旧库阻塞也先结束服务器登录')
  const blocker = await page.context().newPage()
  await holdLegacyDatabase(blocker)
  await openLogoutPreview(page)
  await seedLegacyKeys(page, h.owner.id)
  let logouts = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/logout')
      logouts++
  })
  await page.getByRole('button', { name: '清理本机草稿并退出', exact: true }).click()
  await expect(page.getByText('服务器上的登录已结束。', { exact: true })).toBeVisible()
  await expect(page.getByText(PENDING, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重试未完成步骤', exact: true })).toHaveAttribute('aria-disabled', 'false')
  expect(await sawLegacyDeletion(blocker)).toBe(true)
  expect(await readLocalDisk(page, h.key)).toEqual({ draft: null, writer: null })
  expect(await remainingLegacyKeys(page)).toEqual(REMAINING)
  expect((await page.request.get('/api/auth/session')).status()).toBe(401)
  expect(logouts).toBe(1)
  return { ...h, blocker, logouts: () => logouts }
}

test('US-M4-08 真实旧库 blocked：服务器已退出但本机待清理，关闭占用页重试后才完成', async ({ page }) => {
  const h = await blockedLogout(page)
  await h.blocker.close()
  await page.getByRole('button', { name: '重试未完成步骤', exact: true }).click()
  await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
  expect(await legacyDatabaseKeys(page)).toBeNull()
  expect(await remainingLegacyKeys(page)).toEqual(REMAINING)
  expect(h.logouts()).toBe(1)
  expect(await revisionOf(h.documentId)).toBe(1)
})

for (const { name, nextUser } of [
  { name: '同一人', nextUser: async (owner: TestUser) => owner },
  { name: '其他人', nextUser: async (_owner: TestUser) => createUser('legacy-next') },
]) {
  test(`US-M4-08 旧库 pending 时${name}重新登录：迟到删除与旧重试不碰新记号`, async ({ page, context }) => {
    const h = await blockedLogout(page)
    const user = await nextUser(h.owner)
    const next = await context.newPage()
    await next.goto('/login')
    const login = next.getByRole('form', { name: '登录' })
    await login.getByLabel('用户名', { exact: true }).fill(user.username)
    await login.getByLabel('密码', { exact: true }).fill(user.password)
    await login.getByRole('button', { name: '登录', exact: true }).click()
    await expect(next.getByRole('heading', { name: '我的空间' })).toBeVisible()
    const key = `nerve-office:pending-save:${user.id}:new-login`
    await next.evaluate(key => localStorage.setItem(key, 'new-session'), key)
    await h.blocker.close()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByText('登录状态已经变化，这次退出已停止。请重新预览当前账户后再确认。')).toBeVisible()
    await expect(page.getByRole('button', { name: '重试未完成步骤', exact: true })).toHaveCount(0)
    expect(await next.evaluate(key => localStorage.getItem(key), key)).toBe('new-session')
    expect(await legacyDatabaseKeys(next)).toBeNull()
    expect((await next.request.get('/api/auth/session')).status()).toBe(200)
    expect(h.logouts()).toBe(1)
    await next.close()
  })
}

test('US-M4-09 确证账户停用使用完整旧数据清单，仍保留其他账户的记号', async ({ page, anotherDevice }) => {
  const h = await actualLocalDraft(page, '停用完整清单')
  // 从公开页布置清单，避免旧页后台取钥在刷新时先清 Cookie、却来不及交回停用正文。
  // 这条故事要求新页实际消费确证停用的响应；后台先得知的同页路径由 cleanup-auth 覆盖。
  await page.goto('/reset-password')
  await seedLegacyKeys(page, h.owner.id)
  await seedLegacyDatabase(page)
  const rejected = await captureRejection(page, '/api/auth/session')
  await loginThroughApi(anotherDevice, await createUser('legacy-admin', '管理员', { systemRole: 'admin' }))
  await actAs(anotherDevice, 'POST', `/api/admin/users/${h.owner.id}/disable`)
  await page.goto('/')
  await expect.poll(rejected).toMatchObject({
    status: 401,
    body: { error: { code: 'SESSION_EXPIRED', details: { reason: 'account_disabled', userId: h.owner.id } } },
  })
  await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('reason')).toBe('account_disabled_confirmed')
  await expect(page.getByText('你的账户已被停用。请联系系统管理员确认账户状态。')).toBeVisible()
  await expect.poll(async () => readLocalDisk(page, h.key)).toEqual({ draft: null, writer: null })
  expect(await remainingLegacyKeys(page)).toEqual(REMAINING)
  expect(await legacyDatabaseKeys(page)).toBeNull()
  expect(await revisionOf(h.documentId)).toBe(1)
})
