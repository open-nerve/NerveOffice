// 编辑器页的访问（US-M1-08 的页面部分，P4 设计 §3.7.1）：别人的文档与不存在的文档显示相同；未登录先登录，登录后回到编辑器页。
// 打开之后文档被删除、移走或失去权限（M2 总设计 A14，M2-P6 复核 S8）：页面给出明确的说明——存不进去了、本页的修改有没有保存。
// M3-P1 起保存与心跳续租得知失去访问（404）、编辑权（403）都转为编辑权失效，说明相同：心跳先发现还是保存先发现，界面一样
// （说不说"没有保存"只看本页有没有未保存的内容，审查 B3）。读不到了（404）不提供、也不承诺重新加载：重新加载只会显示"内容不存在"（审查 B2）。
// M3-P2 起失去编辑权之后本页换成只读（没有保存按钮）：还读得到而且有修改时给"另存为副本"与"放弃本页的修改"，没有修改时给"重新加载"。
// 编辑中被收回写入权（US-M3-12，M3 总设计 §2.1 第 4 条）：另一个人经接口降级、取消分享、删除、移动（收回写入权的入口，租约随之结束或过时）——
// 还能阅读（降为查看者，403）时给副本或放弃；读不到了（取消分享、删除，404）就说明并丢弃；被移到仍能编辑的空间时自动续上、接着保存。
// 空间被归档时另存为副本的用例在 edit-mode.spec.ts。核对保存那一步的用例拦下心跳（support/sheet.ts 的 blockLeaseRenewals），免得它先一步
import type { Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { randomUUID } from 'node:crypto'
import { archiveSpace, createDocument, createDocumentIn, createTeamSpace, createUser, editLeaseEpoch, grantDocument, removeMember, revisionOf, withDatabase } from '../../support/database.ts'
import { shownCell } from '../../support/editor-probe.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { actAs, loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { blockLeaseRenewals, cellOf, EDITOR_TEST_TIMEOUT, editorSurface, enterEditButton, expectFoundOnce, lostNotice, openAndEnterEditing, saveAndWait, saveButton, savedContent, saveStatus, typeInCell, waitForEditor, waitForEditorAccess, wouldPromptOnLeave } from '../../support/sheet.ts'

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
    await openAndEnterEditing(page, documentId)
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
    await openAndEnterEditing(page, documentId)
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
    await openAndEnterEditing(page, documentId)
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
    await openAndEnterEditing(page, documentId)
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
      await openAndEnterEditing(page, await createDocumentIn(space.id, lead, '没改过的表'))
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
    await expect(saveStatus(page)).toHaveText('只能查看')
    await expect(saveButton(page)).toHaveCount(0)
  })
})

test.describe('US-M3-12 编辑中被降为查看者：还读得到，没保存的修改可以另存为副本或者放弃', { tag: '@test-build' }, () => {
  test('US-M3-12 编辑中被降为查看者（403）：本页换成只读、显示本页的内容，说明服务端给的原因，给"另存为副本"与"放弃本页的修改"；放弃之后按服务器上的版本回到阅读——没有本页的修改，只能查看、没有"编辑"，离开不再提示', async ({ page, anotherDevice }) => {
    const lead = await createUser('demote-lead', '组长')
    const me = await createUser('demote-me', '被降级的人')
    const space = await createTeamSpace('会被降级', lead, [[lead, 'admin'], [me, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, me)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'B1', '本页的修改')

    // 空间管理员在另一台设备上把我降为查看者（收回写入权：我的编辑权随之结束）；我按保存
    await blockLeaseRenewals(page)
    await loginThroughApi(anotherDevice, lead)
    await actAs(anotherDevice, 'PUT', `/api/spaces/${space.id}/members/${me.id}`, { role: 'viewer' })
    await saveButton(page).click()
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：你已没有编辑这份文档的权限（只能查看这份文档，不能编辑）。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    await expect(lost.getByRole('button', { name: '另存为副本', exact: true })).toBeVisible()
    await waitForEditorAccess(page, 'read')
    await expect(saveButton(page)).toHaveCount(0)
    await expect.poll(async () => shownCell(page, 'B1')).toBe('本页的修改')
    expect(await revisionOf(documentId)).toBe(1)
    expect(await wouldPromptOnLeave(page)).toBe(true)

    // 放弃（先确认）：按服务器上的最新版本以只读重建，没有本页的修改；只能查看，没有"编辑"；没有要保存的了，离开不再提示
    await lost.getByRole('button', { name: '放弃本页的修改', exact: true }).click()
    await page.getByRole('dialog', { name: '放弃本页的修改？' }).getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(lostNotice(page)).toHaveCount(0)
    await expect.poll(async () => shownCell(page, 'B1')).toBeNull()
    await waitForEditorAccess(page, 'read')
    await expect(saveStatus(page)).toHaveText('只能查看')
    await expect(enterEditButton(page)).toHaveCount(0)
    expect(await wouldPromptOnLeave(page)).toBe(false)
    expect(await revisionOf(documentId)).toBe(1)
  })
})

/** 读不到这份文档的两种收回（另一个人在他的浏览器里经接口操作）：取消我的单独授权；把文档删除（进回收站） */
const UNREADABLE: readonly { readonly name: string, readonly revoke: (owner: Page, documentId: string, me: TestUser) => Promise<void> }[] = [
  { name: '取消分享（只凭授权编辑）', revoke: async (owner, documentId, me) => actAs(owner, 'DELETE', `/api/documents/${documentId}/grants/${me.id}`) },
  { name: '文档被删除（进了回收站）', revoke: async (owner, documentId) => actAs(owner, 'DELETE', `/api/documents/${documentId}`) },
]

test.describe('US-M3-12 编辑中失去访问或被移走：读不到了就说明并丢弃；被移到仍能编辑的空间就续上', () => {
  for (const revocation of UNREADABLE) {
    test(`US-M3-12 编辑中${revocation.name}（404）：说明读不到了、本页的修改不能再保存，没有副本与重新加载；本页换成只读，显示的还是本页的内容`, async ({ page, anotherDevice }) => {
      const owner = await createUser('unreadable-owner', '所有者')
      const me = await createUser('unreadable-me', '同事')
      const documentId = await createDocument(owner, '会读不到的表')
      await grantDocument(documentId, me, 'editor', owner)
      await loginThroughApi(page, me)
      await openAndEnterEditing(page, documentId)
      await typeInCell(page, 'B1', '本页的修改')

      await blockLeaseRenewals(page)
      await loginThroughApi(anotherDevice, owner)
      await revocation.revoke(anotherDevice, documentId, me)
      await saveButton(page).click()
      const lost = lostNotice(page)
      await expect(lost).toHaveText(GONE)
      await expect(lost.getByRole('button')).toHaveCount(0)
      await waitForEditorAccess(page, 'read')
      await expect(saveButton(page)).toHaveCount(0)
      await expect(saveStatus(page)).toHaveText('编辑权已失效')
      // 本页的内容还在（以只读重建、显示捕获的内容），需要的话可以复制出来；服务器上什么也没存进去
      await expectFoundOnce(page, '本页的修改')
      expect(await revisionOf(documentId)).toBe(1)
    })
  }

  test('US-M3-12 编辑中文档被移到自己仍能编辑的空间：编辑权随移动中断（代次过时），页面自动续上新的一代，接着保存成功，没有失效的说明', async ({ page, anotherDevice }) => {
    const lead = await createUser('moved-lead', '组长')
    const me = await createUser('moved-me', '同事')
    const from = await createTeamSpace('搬出的空间', lead, [[lead, 'admin'], [me, 'editor']])
    const to = await createTeamSpace('搬入的空间', lead, [[lead, 'admin'], [me, 'editor']])
    const documentId = await createDocumentIn(from.id, lead, '要搬家的表')
    await loginThroughApi(page, me)
    await openAndEnterEditing(page, documentId)
    const before = await editLeaseEpoch(documentId) ?? 0
    await typeInCell(page, 'A1', '搬家前写的')

    // 空间管理员把文档移到另一个空间（我在那里也是编辑者）：保存（或者心跳先一步）得知编辑权过时，期间没人保存过、我仍能编辑，
    // 续上新的一代、用它重发这一次
    await loginThroughApi(anotherDevice, lead)
    await actAs(anotherDevice, 'POST', `/api/documents/${documentId}/move`, { spaceId: to.id })
    await saveAndWait(page)
    expect(await editLeaseEpoch(documentId)).toBeGreaterThan(before)
    await expect(page.getByRole('alert')).toHaveCount(0)
    const saved = await savedContent(page, documentId)
    expect([saved.revision, cellOf(saved.snapshot, 'A1')?.v]).toEqual([2, '搬家前写的'])
    const placed = await withDatabase(async client => (await client.query<{ space_id: string }>('SELECT space_id FROM documents WHERE id = $1', [documentId])).rows[0]?.space_id)
    expect(placed).toBe(to.id)

    // 接着编辑、保存
    await typeInCell(page, 'A2', '搬家后写的')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A2')?.v).toBe('搬家后写的')
  })
})
