// 两个标签页，旧页面的保存不覆盖新内容（US-M1-07，P4 设计 §3.5.2、§3.10）。
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, openEditor, saveAndWait, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

test.describe('US-M1-07 两个标签页，旧页面的保存不覆盖新内容', () => {
  test('A 保存之后 B 再保存：B 得到版本冲突并保留本页的内容，服务器上是 A 的版本', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('conflict'))
    const documentId = await createSheetThroughApi(page)
    const other = await context.newPage()
    await openEditor(page, documentId)
    await openEditor(other, documentId)

    await typeInCell(page, 'A1', 'from A')
    await saveAndWait(page)

    await typeInCell(other, 'A1', 'from B')
    await saveButton(other).click()
    await expect(saveStatus(other)).toHaveText('版本冲突')
    await expect(other.getByRole('alert')).toContainText('别处保存了更新的版本。本页的修改没有保存')
    await expect(other.getByRole('button', { name: '重新加载' })).toBeVisible()
    await expect(saveButton(other)).toHaveAttribute('aria-disabled', 'true')

    const saved = await savedContent(page, documentId)
    expect(cellOf(saved.snapshot, 'A1')?.v).toBe('from A')
    expect(saved.revision).toBe(2)

    // B 保留本页的内容：离开时仍提示有没保存的内容；再按保存也不会覆盖
    await other.keyboard.press('ControlOrMeta+s')
    expect((await savedContent(page, documentId)).revision).toBe(2)
    const dialogs: string[] = []
    other.on('dialog', (dialog) => {
      dialogs.push(dialog.type())
      void dialog.dismiss()
    })
    await other.close({ runBeforeUnload: true })
    await expect.poll(() => dialogs).toEqual(['beforeunload'])
  })

  test('保存已经提交、回包却丢了：再保存时认出是本页自己的保存（自己追自己），不报冲突', async ({ page }) => {
    await loginThroughApi(page, await createUser('conflict-self'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    // 第一次保存：请求照常到达服务端并提交，浏览器却收不到回包
    await page.route('**/api/documents/*/content?*', async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      await route.fetch()
      await route.abort('connectionreset')
    }, { times: 1 })
    await typeInCell(page, 'A1', 'first')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存失败')
    expect((await savedContent(page, documentId)).revision).toBe(2)

    // 接着修改再保存：基准修订号已经过时，冲突的来源是本页那一次保存，换上当前修订号重发
    await typeInCell(page, 'A2', 'second')
    await saveAndWait(page)
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(3)
    expect([cellOf(saved.snapshot, 'A1')?.v, cellOf(saved.snapshot, 'A2')?.v]).toEqual(['first', 'second'])
  })

  test('冲突之后重新加载：看到服务器上的最新版本，可以继续编辑保存', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('conflict-reload'))
    const documentId = await createSheetThroughApi(page)
    const other = await context.newPage()
    await openEditor(page, documentId)
    await openEditor(other, documentId)
    await typeInCell(page, 'A1', 'newer')
    await saveAndWait(page)
    await typeInCell(other, 'B1', 'older page')
    await saveButton(other).click()
    await expect(saveStatus(other)).toHaveText('版本冲突')

    other.once('dialog', dialog => void dialog.accept())
    await other.getByRole('button', { name: '重新加载' }).click()
    await openEditor(other, documentId, 'steady')
    await expect(saveStatus(other)).toHaveText('已保存到云端')
    await typeInCell(other, 'C1', 'after reload')
    await saveAndWait(other)
    const saved = (await savedContent(other, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'B1'), cellOf(saved, 'C1')?.v]).toEqual(['newer', undefined, 'after reload'])
  })
})
