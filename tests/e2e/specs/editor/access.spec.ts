// 编辑器页的访问（US-M1-08 的页面部分，P4 设计 §3.7.1）：别人的文档与不存在的文档显示相同；未登录先登录，登录后回到编辑器页。
import { randomUUID } from 'node:crypto'
import { createDocument, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { editorSurface, waitForEditor } from '../../support/sheet.ts'

test.describe('US-M1-08 编辑器页：别人的与不存在的相同，未登录先登录', () => {
  test('别人的文档与不存在的文档：编辑器页显示相同的说明，不进入编辑', async ({ page }) => {
    const me = await createUser('editor-access-me')
    const other = await createUser('editor-access-other')
    const othersDocument = await createDocument(other, '别人的表格')
    await loginThroughApi(page, me)

    const shown: string[] = []
    for (const id of [othersDocument, randomUUID()]) {
      await page.goto(`/documents/${id}`)
      await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'failed')
      await expect(page.getByText('内容不存在，或者你没有访问权限')).toBeVisible()
      await expect(page.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
      await expect(page.getByText('别人的表格')).toBeHidden()
      shown.push(await page.locator('#editor-chrome').innerText())
    }
    expect(shown[1]).toBe(shown[0])
  })

  test('未登录打开编辑器页：先到登录页，登录后回到编辑器页', async ({ page }) => {
    const owner = await createUser('editor-access-login')
    const documentId = await createDocument(owner, '要先登录的表格')
    await page.goto(`/documents/${documentId}`)
    await expect(page).toHaveURL(new RegExp(`/login\\?from=%2Fdocuments%2F${documentId}$`))
    await loginThroughUi(page, owner)
    await expect(page).toHaveURL(new RegExp(`/documents/${documentId}$`))
    await waitForEditor(page)
    await expect(page.getByRole('heading', { name: '要先登录的表格' })).toBeVisible()
  })
})
