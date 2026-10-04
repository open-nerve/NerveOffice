// 阅读与编辑的切换（M3-P2 设计 §3.1、§3.3、§3.4）：模式切换一律重建编辑器，重建之前取出视图状态（当前工作表、左上角可见的行列、
// 主选区），就绪之后恢复——进入、退出编辑之后同一张表、同一个可见区域、同一个选区（风险表"重建丢掉用户的视图"）。
// 失去编辑权之后另存为副本：上传本页捕获的内容（服务端按快照新建，M3-P2 S2 的接口），本页按服务器上的最新版本回到阅读。
// 进入与退出、两个人、"有更新"等故事的完整 E2E 在 S5（US-M3-01、05、11、12、13）。
import type { Page } from '@playwright/test'
import { archiveSpace, createDocumentIn, createTeamSpace, createUser, withDatabase } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { appendSheet, cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, lostNotice, openAndEnterEditing, saveAndWait, saveButton, savedContent, saveStatus, sheetTab, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 编辑器现在的视图：当前工作表、左上角可见的行列、选区与主单元格（经探针的 Facade 读出；探针随编辑器重建，读的是现在的那一个） */
interface View {
  readonly sheet: string
  readonly top: number
  readonly left: number
  readonly range: string | undefined
  readonly current: string | undefined
}

async function viewOf(page: Page): Promise<View> {
  await expect.poll(async () => page.evaluate(() => window.__nerveEditorProbe !== undefined)).toBe(true)
  return page.evaluate(() => {
    const api = window.__nerveEditorProbe?.univerAPI
    if (api === undefined)
      throw new Error('页面里没有编辑器的探针')
    const workbook = api.getActiveWorkbook()
    const sheet = workbook.getActiveSheet()
    const scroll = sheet.getScrollState()
    return {
      sheet: sheet.getSheetName(),
      top: scroll.sheetViewStartRow,
      left: scroll.sheetViewStartColumn,
      range: sheet.getSelection()?.getActiveRange()?.getA1Notation(),
      current: workbook.getActiveCell()?.getA1Notation(),
    }
  })
}

test.describe('阅读与编辑的切换保留视图（M3-P2 设计 §3.3）', { tag: '@test-build' }, () => {
  test('进入编辑、退出编辑之后：同一张工作表、同一个可见区域、同一个选区', async ({ page }) => {
    await loginThroughApi(page, await createUser('view-state'))
    const documentId = await createSheetThroughApi(page)
    // 两张表：在第二张表上往下、往右滚（第 41 行在最上面；列数不多，往右滚到头时 SDK 按能滚到的最远处停），选中 K45:L47
    await openAndEnterEditing(page, documentId)
    await appendSheet(page)
    await expect(sheetTab(page, '工作表2')).toHaveAttribute('aria-selected', 'true')
    await saveAndWait(page)
    await page.evaluate(() => {
      const sheet = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet()
      if (sheet === undefined)
        throw new Error('页面里没有编辑器的探针')
      sheet.scrollToCell(40, 8)
      sheet.getRange('K45:L47').activate()
    })
    await expect.poll(async () => viewOf(page)).toMatchObject({ sheet: '工作表2', top: 40, range: 'K45:L47', current: 'K45' })
    const expected = await viewOf(page)
    expect(expected.left, '往右滚过了').toBeGreaterThan(0)

    // 退出编辑：以只读重建，视图照旧
    await exitEditing(page)
    await expect(sheetTab(page, '工作表2')).toHaveAttribute('aria-selected', 'true')
    expect(await viewOf(page)).toEqual(expected)

    // 再进入编辑：以可编辑重建，视图照旧
    await enterEditing(page)
    await expect(sheetTab(page, '工作表2')).toHaveAttribute('aria-selected', 'true')
    expect(await viewOf(page)).toEqual(expected)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
  })
})

test.describe('US-M3-12 失去编辑权之后另存为副本（M3-P2 设计 §3.2、§3.4）', () => {
  test('US-M3-12 空间刚被归档（还读得到、不能编辑了）：另存为副本，副本是本页的内容、标题带上失效时的时间、在自己的个人空间；本页按最新的版本回到阅读，链接打开副本', async ({ page }) => {
    const lead = await createUser('copy-lost-lead')
    const editor = await createUser('copy-lost-editor')
    const space = await createTeamSpace('会被归档', lead, [[lead, 'admin'], [editor, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, editor)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', '本页的修改')
    await archiveSpace(space.id)

    // 保存得知不能编辑了（403）：本页换成只读、显示本页的内容，给"另存为副本"与"放弃本页的修改"
    await saveButton(page).click()
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：你已没有编辑这份文档的权限（空间已归档，只能查看）。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    await waitForEditorAccess(page, 'read')

    // 另存为副本：成功之后本页按服务器上的最新版本回到阅读（只能查看），读屏状态区说明已另存为副本，链接在新标签页打开它
    await lost.getByRole('button', { name: '另存为副本', exact: true }).click()
    await expect(lostNotice(page)).toHaveCount(0)
    const notice = page.locator('#editor-chrome').getByRole('status').filter({ hasText: '已另存为副本' })
    await expect(notice).toContainText(/已另存为副本《共同的表（冲突副本 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）》。/)
    await expect(saveStatus(page)).toHaveText('只能查看')
    await waitForEditorAccess(page, 'read')
    const link = notice.getByRole('link', { name: '打开副本（新标签页）', exact: true })
    await expect(link).toHaveAttribute('target', '_blank')
    const copyId = (await link.getAttribute('href') ?? '').split('/').at(-1) ?? ''
    expect(copyId).toMatch(/^[\da-f-]{36}$/)

    // 副本：本页的内容，在自己的个人空间（归档的空间里不能新建）；原文档没有变
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('本页的修改')
    const placed = await withDatabase(async client => (await client.query<{ space_id: string, title: string }>('SELECT space_id, title FROM documents WHERE id = $1', [copyId])).rows[0])
    expect(placed?.space_id).toBe(editor.personalSpaceId)
    expect(placed?.title).toMatch(/^共同的表（冲突副本 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/)
    const original = await savedContent(page, documentId)
    expect([original.revision, cellOf(original.snapshot, 'A1')]).toEqual([1, undefined])

    // 链接打开副本：自己的文档，能编辑
    const [opened] = await Promise.all([page.context().waitForEvent('page'), link.click()])
    await waitForEditorAccess(opened, 'read')
    await enterEditing(opened)
    await expect(saveStatus(opened)).toHaveText('已保存到云端')
  })
})
