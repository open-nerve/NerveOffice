// 重开看到最后一次保存的内容（US-M1-06，P4 设计 §3.10）：值、公式与格式一致；未保存的修改不出现；打开不被判定为有修改。
// 编辑器的内容画在画布上，核对重开之后的内容的办法：重开、不做修改，立即再保存一次，服务器上的内容与上一次保存的相同。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, openEditor, saveAndWait, savedContent, saveStatus, selectCell, typeInCell, waitForEditor } from '../../support/sheet.ts'

/** 值、公式与格式：单元格与样式表 */
function contentOf(snapshot: Workbook) {
  return { sheets: Object.fromEntries(Object.entries(snapshot.sheets).map(([id, sheet]) => [id, sheet.cellData])), styles: snapshot.styles }
}

/** 编辑出值、公式与加粗，保存，返回服务器上的内容 */
async function editAndSave(page: Page, documentId: string): Promise<Workbook> {
  await typeInCell(page, 'A1', 'hello')
  await typeInCell(page, 'A2', '=LEN(A1)')
  await selectCell(page, 'A1')
  await page.getByRole('button', { name: '粗体' }).click()
  await saveAndWait(page)
  const saved = (await savedContent(page, documentId)).snapshot
  expect(cellOf(saved, 'A1')?.v).toBe('hello')
  expect(cellOf(saved, 'A2')).toMatchObject({ f: '=LEN(A1)', v: 5 })
  const style = cellOf(saved, 'A1')?.s
  expect(typeof style === 'string' ? saved.styles[style] : style).toMatchObject({ bl: 1 })
  return saved
}

/**
 * 重开之后不做修改立即再保存一次：服务器上的值、公式与格式与重开之前保存的相同，说明页面打开的就是它。
 * 修订号加一：确实存下了本页捕获的内容，而不是没有保存（审查 B7）
 */
async function contentAfterResave(page: Page, documentId: string): Promise<ReturnType<typeof contentOf>> {
  const before = (await savedContent(page, documentId)).revision
  await saveAndWait(page)
  const after = await savedContent(page, documentId)
  expect(after.revision).toBe(before + 1)
  return contentOf(after.snapshot)
}

test.describe('US-M1-06 重开看到最后一次保存的内容', () => {
  test('保存后刷新：值、公式与格式一致，打开到 steady 之后仍是已保存', async ({ page }) => {
    await loginThroughApi(page, await createUser('reopen-refresh'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const saved = await editAndSave(page, documentId)
    await page.reload()
    await waitForEditor(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await contentAfterResave(page, documentId)).toEqual(contentOf(saved))
  })

  test('退出后重新登录：内容一致', async ({ page }) => {
    const owner = await createUser('reopen-relogin')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const saved = await editAndSave(page, documentId)
    await page.getByRole('link', { name: '我的空间' }).click()
    await page.getByRole('button', { name: '退出' }).click()
    await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
    await loginThroughUi(page, owner)
    await page.getByRole('list', { name: '文档列表' }).getByRole('link').first().click()
    await waitForEditor(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await contentAfterResave(page, documentId)).toEqual(contentOf(saved))
  })

  test('没有保存的修改：离开之后不出现', async ({ page }) => {
    await loginThroughApi(page, await createUser('reopen-unsaved'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const saved = await editAndSave(page, documentId)
    await typeInCell(page, 'B1', 'not saved')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    // 离开提示里选择离开
    page.once('dialog', dialog => void dialog.accept())
    await page.reload()
    await waitForEditor(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await contentAfterResave(page, documentId)).toEqual(contentOf(saved))
  })
})
