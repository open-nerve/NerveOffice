// 编辑器页的访问（US-M1-08 的页面部分，P4 设计 §3.7.1）：别人的文档与不存在的文档显示相同；未登录先登录，登录后回到编辑器页。
// 打开之后文档被删除、移走或失去权限（M2 总设计 A14，M2-P6 复核 S8）：页面给出明确的说明——存不进去了、本页的修改有没有保存。
// M3-P1 起保存与心跳续租得知失去访问（404）、编辑权（403）都转为编辑权失效，说明相同：心跳先发现还是保存先发现，界面一样
// （说不说"没有保存"只看本页有没有未保存的内容，审查 B3）。读不到了（404）不提供、也不承诺重新加载：重新加载只会显示"内容不存在"（审查 B2）。
// M3-P2 起失去编辑权之后本页换成只读（没有保存按钮）：还读得到而且有修改时给"另存为副本"与"放弃本页的修改"，没有修改时给"重新加载"
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { archiveSpace, createDocument, createDocumentIn, createTeamSpace, createUser, removeMember } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { blockLeaseRenewals, EDITOR_TEST_TIMEOUT, editorSurface, lostNotice, openEditor, saveButton, saveStatus, typeInCell, waitForEditor, waitForEditorAccess } from '../../support/sheet.ts'

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

/** 读不到这份文档了、本页有未保存的修改：编辑权失效的说明（存不进去了、本页的修改没有保存、需要的话先复制出来；不提副本与重新加载） */
const GONE = '编辑权已失效：你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改没有保存，也不能再保存到这份文档，需要的话先把内容复制出来。'

test.describe('US-M2-09 A14 编辑器页：打开之后文档被删除、移走或失去权限，给出明确的说明（M2-P6 复核 S8）', () => {
  test('文档已被删除（进了回收站）：说明存不进去了，本页的修改没有保存', async ({ page }) => {
    const owner = await createUser('save-gone')
    const documentId = await createDocument(owner, '要被删的表')
    await loginThroughApi(page, owner)
    await openEditor(page, documentId)
    await typeInCell(page, 'A1', '还没保存的内容')
    await deleteThroughApi(page, documentId)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('编辑权已失效')
    await expect(page.getByRole('alert')).toContainText(GONE)
    await expect(page.getByRole('alert').getByRole('button')).toHaveCount(0)
    await expect(saveButton(page)).toHaveCount(0)
  })

  test('US-M2-09 文档已被删除、本页没有未保存的修改（心跳先得知）：只说本页的修改都已保存，不提供、也不承诺重新加载——重新加载只会显示"内容不存在"（审查 B2）', async ({ page }) => {
    const owner = await createUser('gone-clean')
    const documentId = await createDocument(owner, '没改过就被删的表')
    await loginThroughApi(page, owner)
    await openEditor(page, documentId)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await deleteThroughApi(page, documentId)
    // 心跳每 10 秒一次：下一次就得知读不到了
    await expect(saveStatus(page)).toHaveText('编辑权已失效', { timeout: 15_000 })
    const alert = page.getByRole('alert')
    await expect(alert).toHaveText('编辑权已失效：你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改都已保存。')
    await expect(alert.getByRole('button', { name: '重新加载' })).toHaveCount(0)
    // 页头的返回链接照常在
    await expect(page.locator('#editor-chrome').getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
  })

  test('被移出了空间（失去权限）：同样说明存不进去了', async ({ page }) => {
    const lead = await createUser('save-removed-lead')
    const editor = await createUser('save-removed-editor')
    const space = await createTeamSpace('会被移出', lead, [[lead, 'admin'], [editor, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, editor)
    await openEditor(page, documentId)
    await typeInCell(page, 'A1', '还没保存的内容')
    await removeMember(space.id, editor)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('编辑权已失效')
    await expect(page.getByRole('alert')).toContainText(GONE)
    await expect(page.getByRole('alert').getByRole('button')).toHaveCount(0)
  })

  test('空间刚被归档（能看却不能改了）：用服务端说的原因，并说明本页的修改没有保存', async ({ page }) => {
    const lead = await createUser('save-archived-lead')
    const editor = await createUser('save-archived-editor')
    const space = await createTeamSpace('会被归档', lead, [[lead, 'admin'], [editor, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, editor)
    await openEditor(page, documentId)
    await typeInCell(page, 'A1', '还没保存的内容')
    await archiveSpace(space.id)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('编辑权已失效')
    await expect(page.getByRole('alert')).toContainText('编辑权已失效：你已没有编辑这份文档的权限（空间已归档，只能查看）。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    await expect(page.getByText('你没有执行这个操作的权限')).toHaveCount(0)
  })

  test('US-M2-09 空间刚被归档、本页没有修改：心跳先得知与按了保存才得知，说法一样——本页的修改都已保存，重新加载能以只读看到最新的版本（审查 B3）', async ({ page }) => {
    const lead = await createUser('archived-clean-lead')
    const editor = await createUser('archived-clean-editor')
    await loginThroughApi(page, editor)
    const archived = '编辑权已失效：你已没有编辑这份文档的权限（空间已归档，只能查看）。本页的修改都已保存，重新加载可以看到最新的版本。'
    /** 新建一个团队空间与其中的一份表，打开它（没有任何修改）；返回空间 */
    const openUntouched = async (name: string): Promise<{ id: string }> => {
      const space = await createTeamSpace(name, lead, [[lead, 'admin'], [editor, 'editor']])
      await openEditor(page, await createDocumentIn(space.id, lead, '没改过的表'))
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      return space
    }

    // 心跳先得知：每 10 秒一次，下一次就得知不能编辑了
    const watched = await openUntouched('没改过就归档（心跳）')
    await archiveSpace(watched.id)
    await expect(saveStatus(page)).toHaveText('编辑权已失效', { timeout: 15_000 })
    await expect(page.getByRole('alert')).toContainText(archived)
    const heartbeatFirst = await page.getByRole('alert').innerText()

    // 按了保存（例如习惯性地按 Ctrl+S）、保存先得知：拦下心跳，免得它先一步
    const saved = await openUntouched('没改过就归档（保存）')
    await blockLeaseRenewals(page)
    await archiveSpace(saved.id)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('编辑权已失效')
    await expect(page.getByRole('alert')).toContainText(archived)
    await expect(page.getByRole('alert')).toHaveText(heartbeatFirst, { useInnerText: true })

    // 重新加载：按服务器上的版本重建为阅读（只能查看）
    await page.getByRole('alert').getByRole('button', { name: '重新加载' }).click()
    await expect(lostNotice(page)).toHaveCount(0)
    await waitForEditorAccess(page, 'read')
    await expect(page.locator('#editor-chrome').getByRole('banner').getByText('只能查看', { exact: true })).toBeVisible()
    await expect(saveButton(page)).toHaveCount(0)
  })
})
