// 这些故事只用实际编辑、网络和存储，不依赖测试构建探针；生产容器照常运行。
import type { Request } from '@playwright/test'
import { recordWrites } from '../../support/autosave.ts'
import { revisionOf } from '../../support/database.ts'
import { actualLocalDraft, draftRow, openDraftCatalog } from '../../support/draft-catalog.ts'
import { expect, test } from '../../support/fixtures.ts'
import { readLocalDisk } from '../../support/local-draft.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, saveButton, savedContent, saveStatus, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('US-M4-07 本机草稿的完整用户流程', () => {
  test('离线实际修改可从列表找到；打开文档仍须明确恢复，唯一云端修订确认后清理', async ({ page }) => {
    const h = await actualLocalDraft(page, '从本机草稿页明确恢复')
    await page.goto('/')
    const listItem = page.getByRole('list', { name: '文档列表', exact: true }).getByRole('listitem').filter({ hasText: h.title })
    await expect(listItem.getByText('本机有未同步修改')).toBeVisible()
    await page.goto(`/search?q=${encodeURIComponent(h.title)}`)
    await expect(page.getByRole('link', { name: new RegExp(h.title) }).getByText('本机有未同步修改')).toBeVisible()
    const leases: Request[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes(`/documents/${h.documentId}/edit-lease`))
        leases.push(request)
    })
    const writes = recordWrites(page, h.documentId)
    await page.getByRole('link', { name: '本机草稿', exact: true }).click()
    const row = draftRow(page, h.documentId)
    await expect(row.getByRole('link', { name: '打开文档恢复' })).toHaveAttribute('aria-disabled', 'false')
    expect(leases).toHaveLength(0)
    expect(writes.saves).toHaveLength(0)
    await expect(page.getByRole('region', { name: '本机存储状态' })).toContainText('整个站点')
    expect(await revisionOf(h.documentId)).toBe(1)
    await row.getByRole('link', { name: '打开文档恢复' }).click()
    await waitForEditorAccess(page, 'read', 'steady')
    expect(leases).toHaveLength(0)
    expect((await readLocalDisk(page, h.key)).draft).not.toBeNull()
    await page.locator('[data-slot="recovery-notice"]').getByRole('button', { name: '恢复并编辑' }).click()
    await waitForEditorAccess(page, 'edit')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('从本机草稿页明确恢复')
    expect(await revisionOf(h.documentId)).toBe(2)
    expect(writes.saves).toHaveLength(1)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
    const opened = page.waitForEvent('popup')
    await page.getByRole('link', { name: '本机草稿（新标签页）' }).click()
    const catalog = await opened
    await expect(catalog.getByText('这台设备上没有待处理的本机草稿。')).toBeVisible()
    await catalog.close()
  })

  test('副本首次回包丢失后仍核对同一次请求，只建一份；清理后保留副本入口', async ({ page }) => {
    const h = await actualLocalDraft(page, '只存在本机的副本内容')
    const requests: Request[] = []
    const ids: string[] = []
    await page.route(`**/api/documents/${h.documentId}/conflict-copies?**`, async (route) => {
      requests.push(route.request())
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      ids.push((await response.json() as { id: string }).id)
      if (requests.length === 1)
        await route.abort('failed')
      else
        await route.fulfill({ response })
    })
    await openDraftCatalog(page)
    const row = draftRow(page, h.documentId)
    await row.getByRole('button', { name: '另存为副本', exact: true }).click()
    const retry = row.getByRole('button', { name: '重试另存为副本' })
    await expect(retry).toHaveAttribute('aria-disabled', 'false')
    expect(requests).toHaveLength(1)
    expect((await readLocalDisk(page, h.key)).draft).not.toBeNull()
    await retry.click()
    const link = page.getByRole('link', { name: /^打开副本“/ })
    await expect(link).toBeVisible()
    expect(requests).toHaveLength(2)
    expect(new URL(requests[1]!.url()).search).toBe(new URL(requests[0]!.url()).search)
    expect(requests[1]!.postDataBuffer()).toEqual(requests[0]!.postDataBuffer())
    expect(ids[1]).toBe(ids[0])
    expect(cellOf((await savedContent(page, ids[0]!)).snapshot, 'A1')?.v).toBe('只存在本机的副本内容')
    expect(await revisionOf(h.documentId)).toBe(1)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
    await page.getByRole('button', { name: '重新检查' }).click()
    await expect(page.getByText('这台设备上没有待处理的本机草稿。')).toBeVisible()
    await expect(link).toBeVisible()
    expect((await (await page.request.get(`/api/documents?spaceId=${h.owner.personalSpaceId}`)).json() as { items: unknown[] }).items).toHaveLength(2)
  })

  test('320px 下键盘取消与确认放弃如实清理；行移除后焦点仍可见，云端不受影响', async ({ page }, testInfo) => {
    const h = await actualLocalDraft(page, '需要先确认才放弃')
    await page.setViewportSize({ width: 320, height: 740 })
    await openDraftCatalog(page)
    const row = draftRow(page, h.documentId)
    const before = (await readLocalDisk(page, h.key)).draft
    const discard = row.getByRole('button', { name: '放弃本机修改' })
    await discard.focus()
    await page.keyboard.press('Enter')
    let dialog = page.getByRole('dialog', { name: '放弃这份本机修改？' })
    await expect(dialog).toContainText(h.title)
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(discard).toBeFocused()
    expect((await readLocalDisk(page, h.key)).draft).toEqual(before)
    await page.keyboard.press('Enter')
    dialog = page.getByRole('dialog', { name: '放弃这份本机修改？' })
    await dialog.getByRole('button', { name: '确认放弃' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(row).toContainText('已清除')
    await expect(discard).toBeFocused()
    expect((await readLocalDisk(page, h.key)).draft).toBeNull()
    expect(await revisionOf(h.documentId)).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await testInfo.attach('320px-catalog', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    // 保持行内焦点，让窗口重新聚焦触发刷新和行移除。
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(row).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '本机草稿', level: 1 })).toBeFocused()
    const focused = await page.evaluate(() => {
      const rect = document.activeElement?.getBoundingClientRect()
      return rect !== undefined && rect.top >= 0 && rect.bottom <= window.innerHeight
    })
    expect(focused).toBe(true)
  })
})
