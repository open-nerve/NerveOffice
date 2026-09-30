// 新建表格并进入编辑（US-M1-04，P4 设计 §3.10）：列表里新建 → 整页打开编辑器 → 立即键入被接受；同一个创建请求重复提交只生成一份。
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, createSheetThroughUi, EDITOR_TEST_TIMEOUT, editorSurface, openCellEditor, saveAndWait, savedContent, saveStatus, sheetCanvas, typeInCell, waitForEditor } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

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

  test('编辑器就绪之前不能输入：公式 Worker 迟迟下载不完时，表格点不进去、键入无效；就绪之后照常编辑（Codex 评审 CX1）', async ({ page }) => {
    await loginThroughApi(page, await createUser('create-before-ready'))
    const documentId = await createSheetThroughApi(page)
    // 拦住公式 Worker 的脚本：主线程照常渲染出表格，编辑器等不到 Worker 的回报，停在载入中
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/assets/formula.worker-*.js', async (route) => {
      await released
      await route.continue()
    })
    await page.goto(`/documents/${documentId}`)
    await expect(sheetCanvas(page)).toBeVisible({ timeout: 30_000 })
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'loading')
    await openCellEditor(page, 'A1', { force: true })
    await page.keyboard.type('before ready')
    await page.keyboard.press('Enter')
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'loading')

    release()
    await waitForEditor(page, 'steady')
    // 载入期间的键入没有进到表格里：打开不算修改，保存之后服务器上也没有
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')).toBeUndefined()

    await typeInCell(page, 'A1', 'after ready')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after ready')
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
