// 登录状态变化时的编辑器页（P4 设计 §3.7.3，审查 B1）：本页可能有未保存的修改，所以不整页跳转、不自动重新加载。
// 登录已过期或在别处退出：暂停保存，提示在新标签页中登录，本人登录回来之后恢复；别的标签页登录了另一个人：本页不能再保存。
import { createUser, expireSessions } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, openEditor, saveAndWait, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

test.describe('US-M1-05 登录状态变化时，本页的修改不丢', () => {
  test('登录过期之后保存：留在本页，提示在新标签页中登录；登录回来之后保存成功', async ({ page, context }) => {
    const owner = await createUser('editor-expired')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const editorUrl = page.url()
    await typeInCell(page, 'A1', 'kept')

    await expireSessions(owner)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存失败')
    const alert = page.getByRole('alert').filter({ hasText: '本页的修改还在' })
    await expect(alert).toBeVisible()
    expect(page.url()).toBe(editorUrl)

    const [loginPage] = await Promise.all([context.waitForEvent('page'), alert.getByRole('link', { name: '在新标签页中登录' }).click()])
    await expect(loginPage.getByRole('form', { name: '登录' })).toBeVisible()
    await loginThroughUi(loginPage, owner)
    await expect(loginPage.getByRole('heading', { name: '我的空间' })).toBeVisible()
    // 登录的标签页发出消息，本页向服务端确认是同一个人之后恢复保存
    await expect(alert).toBeHidden()

    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('kept')
  })

  test('别的标签页退出并换人登录：本页不能再保存；原来的人登录回来之后恢复', async ({ page, context }) => {
    const owner = await createUser('editor-owner')
    const someoneElse = await createUser('editor-someone-else')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    await typeInCell(page, 'A1', 'mine')

    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: '退出' }).click()
    await expect(other.getByRole('form', { name: '登录' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '本页的修改还在' })).toBeVisible()

    await loginThroughUi(other, someoneElse)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '别的标签页登录了另一个账户，本页不能再保存' })).toBeVisible()
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')

    await other.getByRole('button', { name: '退出' }).click()
    await loginThroughUi(other, owner)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('mine')
  })
})
