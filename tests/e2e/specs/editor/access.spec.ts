// 编辑器页的访问（US-M1-08 的页面部分，P4 设计 §3.7.1）：别人的文档与不存在的文档显示相同；未登录先登录，登录后回到编辑器页。
// 打开之后文档被删除、移走或失去权限（M2 总设计 A14，M2-P6 复核 S8）：下一次保存给出明确的说明。
// M3-P1 起心跳续租也会得知失去访问（随即说明编辑权已失效）：这几条核对的是保存时的说明，拦下心跳，让保存那一步确定地先到
// （support/sheet.ts 的 blockLeaseRenewals）
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { archiveSpace, createDocument, createDocumentIn, createTeamSpace, createUser, removeMember } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { blockLeaseRenewals, EDITOR_TEST_TIMEOUT, editorSurface, openEditor, saveButton, saveStatus, typeInCell, waitForEditor } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

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

/** 经接口把这份文档删掉（进回收站）：同一个浏览器里的另一个操作，编辑器页不知道 */
async function deleteThroughApi(page: Page, documentId: string): Promise<void> {
  const session = await page.request.get('/api/auth/session')
  const { csrfToken } = await session.json() as { csrfToken: string }
  const response = await page.request.delete(`/api/documents/${documentId}`, { headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken } })
  expect(response.status(), await response.text()).toBe(204)
}

/** 本页的修改存不进去时的说明（页面上的提示，另带请求标识） */
const GONE = '保存失败：这份表格已经被删除、移走，或者你已经没有访问权限，本页的修改没有保存。需要的话先把内容复制出来。'

test.describe('US-M2-09 A14 编辑器页：打开之后文档被删除、移走或失去权限，下一次保存给出明确的说明（M2-P6 复核 S8）', () => {
  test('文档已被删除（进了回收站）：说明存不进去了，本页的修改没有保存', async ({ page }) => {
    const owner = await createUser('save-gone')
    const documentId = await createDocument(owner, '要被删的表')
    await loginThroughApi(page, owner)
    await openEditor(page, documentId)
    await blockLeaseRenewals(page)
    await typeInCell(page, 'A1', '还没保存的内容')
    await deleteThroughApi(page, documentId)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存失败')
    await expect(page.getByRole('alert')).toContainText(GONE)
  })

  test('被移出了空间（失去权限）：同样说明存不进去了', async ({ page }) => {
    const lead = await createUser('save-removed-lead')
    const editor = await createUser('save-removed-editor')
    const space = await createTeamSpace('会被移出', lead, [[lead, 'admin'], [editor, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, editor)
    await openEditor(page, documentId)
    await blockLeaseRenewals(page)
    await typeInCell(page, 'A1', '还没保存的内容')
    await removeMember(space.id, editor)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存失败')
    await expect(page.getByRole('alert')).toContainText(GONE)
  })

  test('空间刚被归档（能看却不能改了）：用服务端说的原因，并说明本页的修改没有保存', async ({ page }) => {
    const lead = await createUser('save-archived-lead')
    const editor = await createUser('save-archived-editor')
    const space = await createTeamSpace('会被归档', lead, [[lead, 'admin'], [editor, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, editor)
    await openEditor(page, documentId)
    await blockLeaseRenewals(page)
    await typeInCell(page, 'A1', '还没保存的内容')
    await archiveSpace(space.id)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存失败')
    await expect(page.getByRole('alert')).toContainText('保存失败：空间已归档，只能查看，本页的修改没有保存。需要的话先把内容复制出来。')
    await expect(page.getByText('你没有执行这个操作的权限')).toHaveCount(0)
  })
})
