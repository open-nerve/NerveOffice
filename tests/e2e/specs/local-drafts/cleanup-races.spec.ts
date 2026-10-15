import type { BrowserContext, Page } from '@playwright/test'
import { failMirrorRemoval, failMirrorRoot, localSessionPhase, mirrorDigests, pauseLogoutAfterBegin } from '../../support/cleanup-fault.ts'
import { createUser, revisionOf } from '../../support/database.ts'
import { draftRow, openDraftCatalog } from '../../support/draft-catalog.ts'
import { test as base, expect } from '../../support/fixtures.ts'
import { readLocalDisk } from '../../support/local-draft.ts'
import { mirrorRecovery, recoverySnapshot, seedRecovery } from '../../support/local-recovery.ts'
import { openLogoutPreview } from '../../support/logout.ts'
import { probePipeline } from '../../support/outbox-probe.ts'
import { firstPage, launchPersistentProfile } from '../../support/persistent-profile.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, savedContent } from '../../support/sheet.ts'

const test = base.extend<{ profile: { readonly context: BrowserContext, readonly page: Page } }>({
  profile: async ({ playwright, browserName, cspViolations, pageErrors }, provide, testInfo) => {
    const context = await launchPersistentProfile(playwright[browserName], testInfo, 'cleanup-races', { cspViolations, pageErrors })
    try {
      await provide({ context, page: await firstPage(context) })
    }
    finally {
      await context.close()
    }
  },
})

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function seed(page: Page) {
  const owner = await createUser('cleanup-races')
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page, '清理并发与根目录失败')
  const key = { userId: owner.id, documentId }
  const cloud = await savedContent(page, documentId)
  const original = await seedRecovery(page, key, recoverySnapshot(cloud.text, '必须明确清理的非空镜像'))
  await mirrorRecovery(page, key, original)
  const mirror = await mirrorDigests(page, key)
  expect(mirror.some(value => !value.includes(':0:'))).toBe(true)
  return { owner, documentId, key, original, mirror }
}

test.describe('独立审查的清理交错', { tag: '@test-build' }, () => {
  test('背景已凭同一原许可清完，前台删除被拒绝仍只退出原服务器会话一次', async ({ profile: { page, context } }) => {
    const h = await seed(page)
    await openLogoutPreview(page)
    const resume = await pauseLogoutAfterBegin(page)
    const requests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/logout')
        requests.push(request.method())
    })
    await page.getByRole('button', { name: '清理本机草稿并退出', exact: true }).click()
    await expect.poll(async () => page.evaluate(() => (window as unknown as { __logoutAfterBegin: { readonly paused: boolean } }).__logoutAfterBegin.paused)).toBe(true)
    // 核对真实 begin 的提交点；锁已释放，当前页的背景维护也可先于下一次读盘清完，clearing 不是稳定终态。
    expect(await page.evaluate(() => (window as unknown as { __logoutAfterBegin: { readonly committedKind: string } }).__logoutAfterBegin.committedKind)).toBe('clearing')
    const background = await context.newPage()
    try {
      await background.goto('/login')
      await expect.poll(async () => localSessionPhase(background)).toBe('cleared')
      expect(await readLocalDisk(background, h.key)).toEqual({ draft: null, writer: null })
      expect(await mirrorDigests(background, h.key)).toEqual([])
      expect((await background.request.get('/api/auth/session')).status()).toBe(200)
      expect(requests).toEqual([])
      await resume()
      await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
      expect(requests).toEqual(['POST'])
      expect((await page.request.get('/api/auth/session')).status()).toBe(401)
      expect(await revisionOf(h.documentId)).toBe(1)
    }
    finally {
      await resume()
      await background.close()
    }
  })

  for (const name of ['UnknownError', 'SecurityError'] as const) {
    test(`非空镜像根 ${name} 时保留原件与墓碑，服务器仍退出；原许可补清后重新登录不复活`, async ({ profile: { page, context } }) => {
      const h = await seed(page)
      await openLogoutPreview(page)
      const observer = await context.newPage()
      await observer.goto('/api/health/ready')
      const release = await failMirrorRoot(page, name)
      const requests: string[] = []
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/auth/logout')
          requests.push(request.method())
      })
      await page.getByRole('button', { name: '清理本机草稿并退出', exact: true }).click()
      await expect(page.getByText('服务器上的登录已结束。', { exact: true })).toBeVisible()
      await expect(page.getByText('本机数据清理失败，尚不能确认数据已清理。请检查浏览器存储后重试。', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '重试未完成步骤' })).toHaveAttribute('aria-disabled', 'false')
      await expect(page.getByText('本机数据已清理。', { exact: true })).toHaveCount(0)
      expect(await localSessionPhase(observer)).toBe('clearing')
      expect((await readLocalDisk(observer, h.key)).draft).toEqual(h.original.disk)
      expect((await readLocalDisk(observer, h.key)).writer?.writerId).toBe('retired')
      expect(await mirrorDigests(observer, h.key)).toEqual(h.mirror)
      expect((await observer.request.get('/api/auth/session')).status()).toBe(401)
      await release()
      await page.getByRole('button', { name: '重试未完成步骤' }).click()
      await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
      expect(await localSessionPhase(observer)).toBe('cleared')
      expect(await readLocalDisk(observer, h.key)).toEqual({ draft: null, writer: null })
      expect(await mirrorDigests(observer, h.key)).toEqual([])
      expect(requests).toEqual(['POST'])
      await loginThroughApi(page, h.owner)
      await openDraftCatalog(page)
      await expect(page.getByText('这台设备上没有待处理的本机草稿。', { exact: true })).toBeVisible()
      await expect(draftRow(page, h.documentId)).toHaveCount(0)
      expect(await readLocalDisk(page, h.key)).toEqual({ draft: null, writer: null })
      expect(await mirrorDigests(page, h.key)).toEqual([])
      expect(await revisionOf(h.documentId)).toBe(1)
    })
  }

  test('保留期根读取失败不丢弃挡住非空镜像的墓碑，恢复可读后也不还原已放弃草稿', async ({ profile: { page } }) => {
    const h = await seed(page)
    const releaseRemoval = await failMirrorRemoval(page)
    expect(await probePipeline(page, 'cleanupAbandon', h.key, h.original.input.meta.draftSeq)).toMatchObject({ kind: 'removed', pending: [h.key] })
    const tombstone = (await readLocalDisk(page, h.key)).writer
    expect(tombstone?.writerId).toBe('retired')
    expect(await mirrorDigests(page, h.key)).toEqual(h.mirror)
    const releaseRoot = await failMirrorRoot(page, 'UnknownError')
    expect(await probePipeline(page, 'cleanupExpired', Date.now())).toMatchObject({ kind: 'purged', mirror: { kind: 'failed' } })
    expect((await readLocalDisk(page, h.key)).writer).toEqual(tombstone)
    await releaseRoot()
    expect(await mirrorDigests(page, h.key)).toEqual(h.mirror)
    expect((await probePipeline(page, 'pageReconcile', h.owner.id)).kind).toBe('reconciled')
    expect((await readLocalDisk(page, h.key)).draft).toBeNull()
    expect((await readLocalDisk(page, h.key)).writer).toEqual(tombstone)
    await releaseRemoval()
    expect(await probePipeline(page, 'cleanupAbandon', h.key)).toMatchObject({ kind: 'absent', pending: [] })
    expect(await mirrorDigests(page, h.key)).toEqual([])
    expect(await revisionOf(h.documentId)).toBe(1)
  })
})
