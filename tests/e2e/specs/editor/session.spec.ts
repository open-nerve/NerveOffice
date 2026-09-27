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
    // 会话的提示已经说明：不再重复"登录已过期"的失败说明（复验 RB2、SB3）
    await expect(page.getByRole('alert')).toHaveCount(1)
    expect(page.url()).toBe(editorUrl)

    const [loginPage] = await Promise.all([context.waitForEvent('page'), alert.getByRole('link', { name: '在新标签页中登录' }).click()])
    await expect(loginPage.getByRole('form', { name: '登录' })).toBeVisible()
    await loginThroughUi(loginPage, owner)
    await expect(loginPage.getByRole('heading', { name: '我的空间' })).toBeVisible()
    // 登录的标签页发出消息，本页向服务端确认是同一个人之后恢复保存；"登录已过期"的失败说明随之清掉（复验 RB2）
    await expect(alert).toBeHidden()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(saveStatus(page)).toHaveText('有未保存的修改')

    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('kept')
  })

  test('确认会话还没结束时按保存：等确认结束，确认是本人之后照常保存（复验 RB1）', async ({ page, context }) => {
    const owner = await createUser('editor-check-pending')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    await typeInCell(page, 'A1', 'waited')
    await expireSessions(owner)
    await saveButton(page).click()
    await expect(page.getByRole('alert').filter({ hasText: '本页的修改还在' })).toBeVisible()

    // 拖住本页确认会话的请求：别的标签页登录之后，本页的确认还没回来时就按保存
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = 0
    await page.route('**/api/auth/session', async (route) => {
      held += 1
      await released
      await route.continue()
    })
    const other = await context.newPage()
    await other.goto('/login')
    await loginThroughUi(other, owner)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    // 本页收到登录的消息、开始确认会话（被拦住）之后再按保存（复验 SB3）
    await expect.poll(() => held).toBe(1)
    const saved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/content?'))
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('正在确认登录状态…')
    release()
    expect((await saved).status()).toBe(200)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('waited')
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
