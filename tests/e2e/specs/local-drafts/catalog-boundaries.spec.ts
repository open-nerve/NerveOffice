// 在真实存储/网络上构造旧原件、镜像和失效分支；目录与操作仍经正式页面。
import type { Page, Request } from '@playwright/test'
import type { ProbeDraftInput } from '../../support/outbox-probe.ts'
import { Buffer } from 'node:buffer'
import { createDocument, createUser, grantDocument, revisionOf } from '../../support/database.ts'
import { draftRow, openDraftCatalog } from '../../support/draft-catalog.ts'
import { expect, test } from '../../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from '../../support/local-draft.ts'
import { recoverySnapshot, seedRecovery } from '../../support/local-recovery.ts'
import { openOutboxProbe, probe, probeDatabase } from '../../support/outbox-probe.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, savedContent } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function seededDraft(page: Page) {
  const owner = await createUser('catalog-edge')
  await loginThroughApi(page, owner)
  const title = `待核对-${owner.username}`
  const documentId = await createSheetThroughApi(page, title)
  const key = { userId: owner.id, documentId }
  const cloud = await savedContent(page, documentId)
  const snapshot = recoverySnapshot(cloud.text, '原本机内容')
  const seeded = await seedRecovery(page, key, snapshot)
  return { owner, title, documentId, key, cloud, snapshot, seeded }
}

/** 相同序号和写入者，以真实加密过程产生另一份完整原件。 */
async function replaceOriginal(page: Page, input: ProbeDraftInput, content: string): Promise<void> {
  await openOutboxProbe(page)
  const secret = await currentLocalKey(page)
  await probe(page, 'chooseKey', secret.version, Buffer.from(secret.key, 'base64').toString('hex'))
  await probeDatabase(page, 'seedDraft', { ...input, content })
}

async function prepareStoredCase(page: Page, h: Awaited<ReturnType<typeof seededDraft>>, state: 'newer-format' | 'key-unavailable' | 'corrupted'): Promise<void> {
  if (state === 'key-unavailable')
    await page.route('**/api/local-key', async route => route.abort('failed'))
  else
    await probeDatabase(page, 'patchDraft', h.key, state === 'newer-format' ? { recordVersion: 2 } : { updatedAt: h.seeded.input.meta.updatedAt + 1 })
}

test.describe('US-M4-07 本机草稿的并发与失败边界', { tag: '@test-build' }, () => {
  test('长列表末尾用键盘放弃后焦点仍在视口；重新检查移除该行后交给可见标题', async ({ page }, testInfo) => {
    const h = await seededDraft(page)
    let last = h.documentId
    for (let index = 1; index <= 8; index += 1) {
      last = await createSheetThroughApi(page, `本机长列表第${index}份需要处理的周报`)
      const cloud = await savedContent(page, last)
      await seedRecovery(page, { userId: h.owner.id, documentId: last }, recoverySnapshot(cloud.text, `第${index}份本机修改`))
    }
    await page.setViewportSize({ width: 320, height: 740 })
    await openDraftCatalog(page)
    const row = draftRow(page, last)
    const button = row.getByRole('button', { name: '放弃本机修改' })
    await expect(button).toHaveAttribute('aria-disabled', 'false')
    await button.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '放弃这份本机修改？' })
    await dialog.getByRole('button', { name: '确认放弃' }).focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(button).toBeFocused()
    await expect(button).toBeInViewport({ ratio: 1 })
    await testInfo.attach('long-list-focus', { body: await page.screenshot(), contentType: 'image/png' })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(row).toHaveCount(0)
    await expect.poll(async () => page.evaluate(() => {
      const target = document.activeElement
      const rect = target?.getBoundingClientRect()
      return target?.matches('h1, [data-draft-heading]') === true && rect !== undefined && rect.top >= 0 && rect.bottom <= innerHeight
    })).toBe(true)
  })

  test('确认框固定完整原件：另页写下同序号不同内容后，旧确认保持新内容与焦点', async ({ page, context }) => {
    const h = await seededDraft(page)
    const other = await context.newPage()
    await openDraftCatalog(page)
    const row = draftRow(page, h.documentId)
    const button = row.getByRole('button', { name: '放弃本机修改' })
    await button.click()
    const dialog = page.getByRole('dialog', { name: '放弃这份本机修改？' })
    await expect(dialog).toContainText(h.title)
    await replaceOriginal(other, h.seeded.input, recoverySnapshot(h.cloud.text, '另页的新原件'))
    const changed = (await readLocalDisk(other, h.key)).draft!
    expect(changed.draftSeq).toBe(h.seeded.disk.draftSeq)
    expect(changed.ciphertextHex).not.toBe(h.seeded.disk.ciphertextHex)
    await dialog.getByRole('button', { name: '确认放弃' }).click()
    await expect(row).toContainText('已经变化')
    // WebKit 鼠标点击不让按钮取得焦点，关闭时走本行标题的回退；键盘打开的原按钮归位由上一例覆盖。
    const focus = row.locator('button:focus, [data-draft-heading]:focus')
    await expect(focus).toHaveCount(1)
    await expect(focus).toBeInViewport({ ratio: 1 })
    expect((await readLocalDisk(page, h.key)).draft).toEqual(changed)
    expect(await revisionOf(h.documentId)).toBe(1)
    await other.close()
  })

  test('未知副本期间另一页换原件：重试仍是原 requestId 和原字节，完成后不误删新内容', async ({ page, context }) => {
    const h = await seededDraft(page)
    const requests: Request[] = []
    await page.route(`**/api/documents/${h.documentId}/conflict-copies?**`, async (route) => {
      requests.push(route.request())
      if (requests.length === 1)
        await route.abort('failed')
      else
        await route.continue()
    })
    await openDraftCatalog(page)
    const row = draftRow(page, h.documentId)
    await row.getByRole('button', { name: '另存为副本', exact: true }).click()
    await expect(row.getByRole('button', { name: '重试另存为副本' })).toHaveAttribute('aria-disabled', 'false')
    const other = await context.newPage()
    await replaceOriginal(other, h.seeded.input, recoverySnapshot(h.cloud.text, '尚待处理的新原件'))
    const changed = (await readLocalDisk(other, h.key)).draft
    await row.getByRole('button', { name: '重试另存为副本' }).click()
    const link = page.getByRole('link', { name: /^打开副本“/ })
    await expect(link).toBeVisible()
    await expect(row).toContainText('已经变化')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.url()).toBe(requests[0]!.url())
    expect(requests[1]!.postDataBuffer()).toEqual(h.seeded.gzip)
    expect(requests[1]!.postDataBuffer()).toEqual(requests[0]!.postDataBuffer())
    const copyId = (await link.getAttribute('href'))!.split('/').at(-1)!
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('原本机内容')
    expect((await readLocalDisk(page, h.key)).draft).toEqual(changed)
    await expect(row.getByRole('button', { name: '另存为副本', exact: true })).toHaveAttribute('aria-disabled', 'true')
    await other.close()
  })

  test('只读分享仍有本人标记和副本入口；关闭新写功能不隐藏旧草稿', async ({ page }) => {
    const author = await createUser('catalog-author')
    const viewer = await createUser('catalog-viewer')
    const documentId = await createDocument(author, '共享的未同步文档')
    await grantDocument(documentId, viewer, 'viewer', author)
    await loginThroughApi(page, viewer)
    const key = { userId: viewer.id, documentId }
    const cloud = await savedContent(page, documentId)
    await seedRecovery(page, key, recoverySnapshot(cloud.text, '只读后的本机修改'))
    await page.route('**/api/auth/session', async (route) => {
      const response = await route.fetch()
      const body = await response.json() as Record<string, unknown>
      await route.fulfill({ response, json: { ...body, features: { localDraftsEnabled: false } } })
    })
    await page.goto('/shared')
    await expect(page.getByRole('link', { name: /共享的未同步文档/ }).getByText('本机有未同步修改')).toBeVisible()
    await page.getByRole('link', { name: '本机草稿', exact: true }).click()
    const row = draftRow(page, documentId)
    await expect(row.getByRole('link', { name: '打开文档恢复' })).toHaveAttribute('aria-disabled', 'true')
    await row.getByRole('button', { name: '另存为副本', exact: true }).click()
    const link = page.getByRole('link', { name: /^打开副本“/ })
    await expect(link).toBeVisible()
    const copyId = (await link.getAttribute('href'))!.split('/').at(-1)!
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('只读后的本机修改')
    expect(await revisionOf(documentId)).toBe(1)
    expect((await readLocalDisk(page, key)).draft).toBeNull()
  })

  test('权限查询未知时隐藏标题但保留原件；确定文档已删除后才清理', async ({ page }) => {
    const h = await seededDraft(page)
    await page.route('**/api/documents/draft-facts?**', async route => route.abort('failed'))
    await openDraftCatalog(page)
    const row = draftRow(page, h.documentId)
    await expect(row.getByRole('heading')).toHaveText('无法确认文档')
    await expect(page.getByRole('alert')).toContainText('暂时无法确认文档')
    expect((await readLocalDisk(page, h.key)).draft).toEqual(h.seeded.disk)
    await page.unroute('**/api/documents/draft-facts?**')
    await page.getByRole('button', { name: '重新检查' }).click()
    await expect(row.getByRole('heading')).toHaveText(h.title)
    await actAs(page, 'DELETE', `/api/documents/${h.documentId}`)
    await page.getByRole('button', { name: '重新检查' }).click()
    await expect(row).toContainText('已无法访问这份文档')
    await expect(row.getByRole('heading')).toHaveText('无法确认文档')
    expect((await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  for (const state of ['newer-format', 'key-unavailable', 'corrupted'] as const) {
    test(`${state} 的目录说明、保留和清理均来自共享判定`, async ({ page }) => {
      const h = await seededDraft(page)
      await prepareStoredCase(page, h, state)
      const before = (await readLocalDisk(page, h.key)).draft
      await openDraftCatalog(page)
      const row = draftRow(page, h.documentId)
      await expect(row).toContainText(state === 'newer-format' ? '本机修改由更新版本写入' : state === 'key-unavailable' ? '密钥' : '损坏的本机草稿已清除')
      await expect(row.getByRole('button', { name: '另存为副本', exact: true })).toHaveAttribute('aria-disabled', 'true')
      await expect(row.getByRole('button', { name: '放弃本机修改' })).toHaveAttribute('aria-disabled', state === 'key-unavailable' ? 'false' : 'true')
      expect((await readLocalDisk(page, h.key)).draft).toEqual(state === 'corrupted' ? null : before)
      expect(await revisionOf(h.documentId)).toBe(1)
    })
  }

  test('主库暂时列不出来不能报告空；解除故障后同页重试找回原记录', async ({ page }) => {
    const h = await seededDraft(page)
    await page.addInitScript(() => {
      const original: typeof IDBObjectStore.prototype.openCursor = Reflect.get(IDBObjectStore.prototype, 'openCursor')
      Object.assign(window, { __catalogReadFailure: true })
      IDBObjectStore.prototype.openCursor = function (...args) {
        if (this.name === 'drafts' && (window as unknown as { __catalogReadFailure: boolean }).__catalogReadFailure)
          throw new DOMException('测试列表读盘失败', 'UnknownError')
        return Reflect.apply(original, this, args)
      }
    })
    await openDraftCatalog(page)
    await expect(page.getByRole('alert')).toContainText('列表可能不完整')
    await expect(page.getByText('这台设备上没有待处理的本机草稿。')).toHaveCount(0)
    expect((await readLocalDisk(page, h.key)).draft).toEqual(h.seeded.disk)
    await page.evaluate(() => {
      (window as unknown as { __catalogReadFailure: boolean }).__catalogReadFailure = false
    })
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(draftRow(page, h.documentId).getByRole('heading')).toHaveText(h.title)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('换人后不列原用户的草稿；重新登录原账户仍能找到同一原件', async ({ page }) => {
    const h = await seededDraft(page)
    const other = await createUser('catalog-other')
    await openDraftCatalog(page)
    await expect(draftRow(page, h.documentId).getByRole('heading')).toHaveText(h.title)
    await loginThroughApi(page, other)
    await openDraftCatalog(page)
    await expect(page.getByText('这台设备上没有待处理的本机草稿。')).toBeVisible()
    await expect(page.getByText(h.title)).toHaveCount(0)
    expect((await readLocalDisk(page, h.key)).draft).toEqual(h.seeded.disk)
    await loginThroughApi(page, h.owner)
    await openDraftCatalog(page)
    await expect(draftRow(page, h.documentId).getByRole('heading')).toHaveText(h.title)
    expect(diskSnapshot((await readLocalDisk(page, h.key)).draft!, await currentLocalKey(page))).toBe(h.snapshot)
  })

  test('另一页换人后旧草稿页重新聚焦，不再显示原账户已完成副本的标题和链接', async ({ page, context }) => {
    const h = await seededDraft(page)
    await openDraftCatalog(page)
    await draftRow(page, h.documentId).getByRole('button', { name: '另存为副本', exact: true }).click()
    const link = page.getByRole('link', { name: /^打开副本“/ })
    await expect(link).toBeVisible()
    const other = await context.newPage()
    await loginThroughApi(other, await createUser('catalog-switch'))
    await openDraftCatalog(other)
    await expect(other.getByText('这台设备上没有待处理的本机草稿。')).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(link).toHaveCount(0)
    await expect(page.getByText(h.title, { exact: true })).toHaveCount(0)
    await other.close()
  })
})
