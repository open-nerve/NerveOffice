import type { Page } from '@playwright/test'
import type { Workbook } from './sheet.ts'
import { createUser, expireEditLease } from './database.ts'
import { expect } from './fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from './local-draft.ts'
import { loginThroughApi } from './session.ts'
import { cellOf, createSheetThroughApi, openAndEnterEditing, typeInCell } from './sheet.ts'

export function draftRow(page: Page, documentId: string) {
  return page.locator(`[data-draft-id="${documentId}"]`)
}

export async function openDraftCatalog(page: Page): Promise<void> {
  await page.goto('/local-drafts')
  await expect(page.getByRole('heading', { level: 1, name: '本机草稿' })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新检查', exact: true })).toHaveAttribute('aria-disabled', 'false')
}

/** 生产输入、真实离线、真实 Worker 落盘；关闭编辑页后仅令测试租约到期。 */
export async function actualLocalDraft(page: Page, value: string) {
  const owner = await createUser('draft-catalog')
  await loginThroughApi(page, owner)
  const title = `待同步周报-${owner.username}`
  const documentId = await createSheetThroughApi(page, title)
  const key = { userId: owner.id, documentId }
  const secret = await currentLocalKey(page)
  const editor = await page.context().newPage()
  await openAndEnterEditing(editor, documentId)
  try {
    await page.context().setOffline(true)
    await typeInCell(editor, 'A1', value)
    await expect.poll(async () => {
      const draft = (await readLocalDisk(editor, key)).draft
      return draft === null ? undefined : cellOf(JSON.parse(diskSnapshot(draft, secret)) as Workbook, 'A1')?.v
    }).toBe(value)
    await expect(editor.locator('[data-slot="local-save-status"] summary')).toHaveText('已离线，修改已保存在本机')
    expect((await readLocalDisk(editor, key)).draft?.inFlight).toBeNull()
  }
  finally {
    await editor.close()
    await page.context().setOffline(false)
  }
  await expireEditLease(documentId)
  return { owner, documentId, key, title, secret }
}
