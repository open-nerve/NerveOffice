import type { Page } from '@playwright/test'
import { createUser, revisionOf } from '../../support/database.ts'
import { draftRow, openDraftCatalog } from '../../support/draft-catalog.ts'
import { expect, test } from '../../support/fixtures.ts'
import { readLocalDisk } from '../../support/local-draft.ts'
import { recoverySnapshot, seedRecovery } from '../../support/local-recovery.ts'
import { probeDatabase } from '../../support/outbox-probe.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, savedContent, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function seed(page: Page, name: string, old = false) {
  const owner = await createUser('startup-draft', name)
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page, name)
  const key = { userId: owner.id, documentId }
  const cloud = await savedContent(page, documentId)
  const snapshot = recoverySnapshot(cloud.text, name)
  const original = await seedRecovery(page, key, snapshot, old ? { updatedAt: Date.now() - 15 * 24 * 60 * 60 * 1000 } : {})
  return { owner, documentId, key, original }
}

/** 只关闭新草稿能力；响应的实际身份、CSRF 与服务器权限仍来自后端。 */
async function disableNewDrafts(page: Page): Promise<void> {
  await page.route('**/api/auth/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { features?: object }
    await route.fulfill({ response, json: { ...body, features: { ...body.features, localDraftsEnabled: false } } })
  })
}

async function startEntry(page: Page, entry: 'platform' | 'editor', documentId: string): Promise<void> {
  await page.goto(entry === 'platform' ? '/' : `/documents/${documentId}`)
  if (entry === 'platform')
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
  else
    await waitForEditorAccess(page, 'read', 'steady')
}

async function invalidate(page: Page, other: Page, h: Awaited<ReturnType<typeof seed>>, cause: 'unreadable' | 'revoked' | 'corrupted'): Promise<void> {
  if (cause === 'unreadable') {
    await actAs(page, 'DELETE', `/api/documents/${h.documentId}`)
  }
  else if (cause === 'revoked') {
    await loginThroughApi(other, await createUser('startup-admin', '吊销密钥的人', { systemRole: 'admin' }))
    await actAs(other, 'POST', `/api/admin/users/${h.owner.id}/local-key/revoke`)
  }
  else {
    // 保持元数据可读，仅改变 AAD，真实解密必须确认损坏才删除。
    await probeDatabase(page, 'patchDraft', h.key, { updatedAt: h.original.input.meta.updatedAt + 1 })
  }
}

async function expectClearedMarker(page: Page, entry: 'platform' | 'editor', cause: 'unreadable' | 'revoked' | 'corrupted'): Promise<void> {
  if (entry !== 'platform' || cause === 'unreadable')
    return
  const listed = page.getByRole('link', { name: /需要启动时核对的草稿/ })
  await expect(listed).toBeVisible()
  await expect(listed.getByText('本机有未同步修改')).toHaveCount(0)
}

test.describe('启动维护在部署关闭新草稿后仍处理既有原件', { tag: '@test-build' }, () => {
  for (const entry of ['platform', 'editor'] as const) {
    for (const cause of ['unreadable', 'revoked', 'corrupted'] as const) {
      test(`${{ unreadable: 'US-M4-09', revoked: 'US-M4-10', corrupted: 'US-M4-10' }[cause]} ${entry} 启动自动核对 ${cause} 并清理，未进入草稿页也生效`, async ({ page, anotherDevice }) => {
        const h = await seed(page, '需要启动时核对的草稿')
        const landing = await createSheetThroughApi(page, '仍可阅读的文档')
        await invalidate(page, anotherDevice, h, cause)
        await disableNewDrafts(page)
        await startEntry(page, entry, landing)
        await expect.poll(async () => (await readLocalDisk(page, h.key)).draft === null).toBe(true)
        const notice = page.getByText({ unreadable: '已无法访问这份文档，对应的本机草稿已清除', revoked: '密钥失效的本机草稿已清除', corrupted: '损坏的本机草稿已清除' }[cause], { exact: true })
        await expect(notice).toBeVisible()
        await expectClearedMarker(page, entry, cause)
        // 当前目录已经空，再检查仍应解释刚完成的清理，而不是把完成事实抹掉。
        const retry = page.getByRole('button', { name: '重试本机维护' })
        await retry.click()
        await expect(retry).toHaveAttribute('aria-disabled', 'false')
        await expect(notice).toBeVisible()
        expect(await revisionOf(h.documentId)).toBe(1)
        expect(await revisionOf(landing)).toBe(1)
      })
    }

    test(`US-M4-12 ${entry} 启动清理所有账户的过期草稿，但提示与标题只属于当前账户`, async ({ page }) => {
      const other = await seed(page, '乙账户的过期原件', true)
      const current = await seed(page, '甲账户的过期原件', true)
      const landing = await createSheetThroughApi(page, '保留的云端文档')
      await disableNewDrafts(page)
      await startEntry(page, entry, landing)
      await expect.poll(async () => (await readLocalDisk(page, other.key)).draft === null).toBe(true)
      await expect.poll(async () => (await readLocalDisk(page, current.key)).draft === null).toBe(true)
      await expect(page.getByText('部分本机草稿因超过 14 天保留期已清理，可在本机草稿页查看提示。')).toBeVisible()
      await expect(page.getByText('乙账户的过期原件', { exact: true })).toHaveCount(0)
      await openDraftCatalog(page)
      await expect(draftRow(page, current.documentId)).toContainText('本机草稿超过 14 天保留期，已清理')
      await expect(draftRow(page, other.documentId)).toHaveCount(0)
      await loginThroughApi(page, other.owner)
      await openDraftCatalog(page)
      await expect(draftRow(page, other.documentId)).toContainText('本机草稿超过 14 天保留期，已清理')
      await expect(draftRow(page, current.documentId)).toHaveCount(0)
      expect(await revisionOf(current.documentId)).toBe(1)
      expect(await revisionOf(other.documentId)).toBe(1)
    })
  }
})
