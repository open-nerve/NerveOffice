// 新建表格并进入编辑（US-M1-04，P4 设计 §3.10）：列表里新建 → 整页打开编辑器 → 立即键入被接受；同一个创建请求重复提交只生成一份。
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughUi, saveAndWait, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

test.describe('US-M1-04 新建表格并进入编辑', () => {
  test('列表里新建：整页打开编辑器页，空白表格立即可以输入，保存后在服务器上', async ({ page }) => {
    await loginThroughApi(page, await createUser('create-sheet'))
    const documentId = await createSheetThroughUi(page)
    await expect(page.getByRole('heading', { name: '未命名表格' })).toBeVisible()
    await expect(saveStatus(page)).toHaveText('已保存到云端')

    await typeInCell(page, 'A1', 'hello')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await saveAndWait(page)
    const { snapshot, revision } = await savedContent(page, documentId)
    expect(cellOf(snapshot, 'A1')?.v).toBe('hello')
    expect(revision).toBe(2)

    // 回到列表：新建的文档在最前面
    await page.getByRole('link', { name: '我的空间' }).click()
    await expect(page.getByRole('list', { name: '文档列表' }).getByRole('link').first()).toHaveAttribute('href', `/documents/${documentId}`)
  })

  test('同一个 requestId 的两次新建请求只生成一份文档（接口层）', async ({ page }) => {
    await loginThroughApi(page, await createUser('create-once'))
    const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
    const requestId = randomUUID()
    const post = async () => page.request.post('/api/documents', { data: { type: 'sheet', title: '只建一份', requestId }, headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken } })
    const [first, second] = [await post(), await post()]
    expect([first.status(), second.status()]).toEqual([201, 201])
    expect((await second.json() as { id: string }).id).toBe((await first.json() as { id: string }).id)
    await page.goto('/')
    await expect(page.getByRole('list', { name: '文档列表' }).getByRole('listitem')).toHaveCount(1)
  })
})
