// 新建表格并进入编辑（US-M1-04，P4 设计 §3.10）：列表里新建 → 整页打开编辑器 → 立即键入被接受；同一个创建请求重复提交只生成一份。
import { randomUUID } from 'node:crypto'
import { createTeamSpace, createUser, withDatabase } from '../../support/database.ts'
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

  test('新建的结果未知（其实已经建好）→ 给它改名 → 去别的空间再回来 → 再点"新建表格"：说明上一次其实已经完成，不打开改过名的那一份；再点才新建一份（M2-P6 复核第二批 S-1）', async ({ page }) => {
    const owner = await createUser('create-replayed')
    const elsewhere = await createTeamSpace('别处', owner, [[owner, 'admin']])
    await loginThroughApi(page, owner)
    await page.goto('/')
    let first = true
    await page.route('**/api/documents', async (route) => {
      if (route.request().method() !== 'POST' || !first)
        return route.continue()
      first = false
      // 服务端照常建好，回包换成代理的 502：结果未知
      await route.fetch()
      return route.fulfill({ status: 502, contentType: 'text/html', body: 'bad gateway' })
    })
    await page.getByRole('button', { name: '新建表格', exact: true }).click()
    await expect(page.getByText(/^没能确认表格是否已经建好/)).toBeVisible()
    // 它确实建好了：在列表里改名
    await page.getByRole('button', { name: '操作 未命名表格', exact: true }).click()
    await page.getByRole('button', { name: '改名', exact: true }).click()
    await page.getByLabel('未命名表格 的新名称', { exact: true }).fill('第一季度预算')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('第一季度预算')
    // 去别的空间、再回来（单页里切换）
    const nav = page.getByRole('navigation', { name: '空间' })
    await nav.getByRole('link', { name: elsewhere.name }).click()
    await expect(page.getByRole('heading', { level: 1, name: elsewhere.name })).toBeVisible()
    await nav.getByRole('link', { name: '我的空间' }).click()
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('第一季度预算')

    // 想再建一份：服务端认出那个 requestId，按重放回答——说明上一次其实已经完成，不打开它
    await page.getByRole('button', { name: '新建表格', exact: true }).click()
    await expect(page.getByText('上一次新建其实已经完成（当时没能确认结果），这次没有再建一份：就是「第一季度预算」。还要另建一份时，再点"新建表格"。')).toBeVisible()
    // 说明条接住焦点，读屏随之读出（M2-P6 复核第三批 G-b）
    await expect(page.getByRole('status').filter({ hasText: '上一次新建其实已经完成' })).toBeFocused()
    await expect(page).toHaveURL('/')
    const replayedLink = page.getByRole('link', { name: '打开它', exact: true })
    await expect(replayedLink).toHaveAttribute('href', /^\/documents\/[\da-f-]{36}$/)
    const replayedPath = await replayedLink.getAttribute('href')
    const countActive = async (): Promise<number> => withDatabase(async client => Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM documents WHERE space_id = $1 AND status = \'active\'', [owner.personalSpaceId])).rows[0]?.n))
    expect(await countActive()).toBe(1)

    // 这件事了结了：再点就是新建一份，整页打开它
    await page.getByRole('button', { name: '新建表格', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[\da-f-]{36}$/)
    expect(new URL(page.url()).pathname).not.toBe(replayedPath)
    expect(await countActive()).toBe(2)
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
