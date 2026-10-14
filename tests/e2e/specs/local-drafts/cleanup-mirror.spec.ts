import type { Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { failMirrorRemoval, mirrorDigests } from '../../support/cleanup-fault.ts'
import { createUser, revisionOf } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { readLocalDisk } from '../../support/local-draft.ts'
import { mirrorRecovery, recoverySnapshot, seedRecovery } from '../../support/local-recovery.ts'
import { openLogoutPreview } from '../../support/logout.ts'
import { firstPage, launchPersistentProfile } from '../../support/persistent-profile.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, savedContent } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function pendingLogout(page: Page, rootOnly = false) {
  const owner = await createUser('logout-mirror')
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page, '退出时镜像待清理')
  const key = { userId: owner.id, documentId }
  const cloud = await savedContent(page, documentId)
  const seeded = await seedRecovery(page, key, recoverySnapshot(cloud.text, '真正保存到备份的本机内容'))
  await mirrorRecovery(page, key, seeded)
  const before = await mirrorDigests(page, key)
  expect(before.length).toBeGreaterThan(0)
  await openLogoutPreview(page)
  const release = await failMirrorRemoval(page, rootOnly ? owner.id : undefined)
  const logouts: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/logout')
      logouts.push(request.method())
  })
  await page.getByRole('button', { name: '清理本机草稿并退出' }).click()
  await expect(page.getByText('服务器上的登录已结束。', { exact: true })).toBeVisible()
  await expect(page.getByText('本机数据尚未全部清理。请关闭其它正在使用本站的标签页后重试。')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试未完成步骤' })).toHaveAttribute('aria-disabled', 'false')
  // 用户清理先退役写入者；镜像未删的记录保留到原资格补清，不把单条放弃的顺序套在用户清理上。
  expect((await readLocalDisk(page, key)).draft).toEqual(rootOnly ? null : seeded.disk)
  expect((await readLocalDisk(page, key)).writer?.writerId).toBe(rootOnly ? undefined : 'retired')
  expect(await mirrorDigests(page, key)).toEqual(rootOnly ? [] : before)
  expect(logouts).toEqual(['POST'])
  expect((await page.request.get('/api/auth/session')).status()).toBe(401)
  return { owner, documentId, key, before, release, logouts }
}

test.describe('公开退出页与持久待清理资格', { tag: '@test-build' }, () => {
  test('只剩空用户目录仍报未清完，不因 pending 列表为空提前成功；重试才进入登录页', async ({ playwright, browserName, cspViolations, pageErrors }, testInfo) => {
    const context = await launchPersistentProfile(playwright[browserName], testInfo, 'logout-empty-root', { cspViolations, pageErrors })
    const page = await firstPage(context)
    try {
      const h = await pendingLogout(page, true)
      await expect(page).toHaveURL(/\/logout$/)
      await expect(page.getByText('本机数据已清理。', { exact: true })).toHaveCount(0)
      await h.release()
      await page.getByRole('button', { name: '重试未完成步骤' }).click()
      await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
      expect(h.logouts).toEqual(['POST'])
    }
    finally {
      await context.close()
    }
  })

  test('镜像失败时退役写入者并保留未清原件；解除占用后只补本机清理，不再次退出服务器', async ({ playwright, browserName, cspViolations, pageErrors }, testInfo) => {
    const context = await launchPersistentProfile(playwright[browserName], testInfo, 'logout-retry', { cspViolations, pageErrors })
    const page = await firstPage(context)
    try {
      const h = await pendingLogout(page)
      await h.release()
      await page.getByRole('button', { name: '重试未完成步骤' }).click()
      await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
      expect(await mirrorDigests(page, h.key)).toEqual([])
      expect(await readLocalDisk(page, h.key)).toEqual({ draft: null, writer: null })
      expect(h.logouts).toEqual(['POST'])
      expect(await revisionOf(h.documentId)).toBe(1)
    }
    finally {
      await context.close()
    }
  })

  test('关闭未清完的退出页后，下一次公开入口启动补清原资格，不展示上个账户身份', async ({ playwright, browserName, cspViolations, pageErrors }, testInfo) => {
    const context = await launchPersistentProfile(playwright[browserName], testInfo, 'logout-resume', { cspViolations, pageErrors })
    const page = await firstPage(context)
    try {
      const h = await pendingLogout(page)
      const next = await context.newPage()
      await page.close()
      await next.goto('/login')
      await expect(next.getByRole('form', { name: '登录' })).toBeVisible()
      await expect.poll(async () => mirrorDigests(next, h.key)).toEqual([])
      expect(await readLocalDisk(next, h.key)).toEqual({ draft: null, writer: null })
      await expect(next.getByText(h.owner.displayName, { exact: true })).toHaveCount(0)
      expect(h.logouts).toEqual(['POST'])
      expect(await revisionOf(h.documentId)).toBe(1)
    }
    finally {
      await context.close()
    }
  })

  for (const { name, nextUser } of [
    { name: '同一人', nextUser: async (owner: TestUser) => owner },
    { name: '其他人', nextUser: async (_owner: TestUser) => createUser('pending-next') },
  ]) {
    test(`镜像未清完时${name}重新登录并保存：旧重试失效，保留新主库与镜像`, async ({ playwright, browserName, cspViolations, pageErrors }, testInfo) => {
      const context = await launchPersistentProfile(playwright[browserName], testInfo, 'logout-changed', { cspViolations, pageErrors })
      const page = await firstPage(context)
      try {
        const h = await pendingLogout(page)
        const next = await context.newPage()
        const current = await nextUser(h.owner)
        await loginThroughApi(next, current)
        const documentId = await createSheetThroughApi(next, '新登录写下的草稿')
        const key = { userId: current.id, documentId }
        const cloud = await savedContent(next, documentId)
        const seeded = await seedRecovery(next, key, recoverySnapshot(cloud.text, '旧重试不能删除的新内容'))
        await mirrorRecovery(next, key, seeded)
        const original = await readLocalDisk(next, key)
        const mirror = await mirrorDigests(next, key)
        expect(mirror.length).toBeGreaterThan(0)
        await h.release()
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await expect(page.getByText('登录状态已经变化，这次退出已停止。请重新预览当前账户后再确认。')).toBeVisible()
        await expect(page.getByRole('button', { name: '重试未完成步骤' })).toHaveCount(0)
        expect(await readLocalDisk(next, key)).toEqual(original)
        expect(await mirrorDigests(next, key)).toEqual(mirror)
        expect(h.logouts).toEqual(['POST'])
        expect((await next.request.get('/api/auth/session')).status()).toBe(200)
        expect(await revisionOf(documentId)).toBe(1)
      }
      finally {
        await context.close()
      }
    })
  }
})
