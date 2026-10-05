// 重开看到最后一次保存的内容（US-M1-06，P4 设计 §3.10）：值、公式与格式一致；未保存的修改不出现；打开不被判定为有修改。
// 编辑器的内容画在画布上，核对重开之后的内容的办法：重开、不做修改，立即再保存一次，上传的内容与上一次保存的相同
// （M3-P3 起服务端判为内容相同、修订号不变，所以看上传的正文）。
// M3-P2 起打开即阅读：重开之后点"编辑"进入编辑（以可编辑重建），再核对"打开不被判定为有修改"与重新保存。
// "就绪之前"的两条带 ?edit=new 打开（直接以可编辑创建）：载入中的是能编辑的编辑器，验的是交互屏障，不是只读守卫（审查 A8）。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, editorSurface, enterEditing, hoverCell, leaveEditor, openAndEnterEditing, reloadAndEnterEditing, resourceOf, saveAndCapture, saveAndWait, savedContent, saveStatus, selectCell, sheetCanvas, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 值、公式与格式：单元格与样式表 */
function contentOf(snapshot: Workbook) {
  return { sheets: Object.fromEntries(Object.entries(snapshot.sheets).map(([id, sheet]) => [id, sheet.cellData])), styles: snapshot.styles }
}

/** 编辑出值、公式与加粗，保存，返回服务器上的内容 */
async function editAndSave(page: Page, documentId: string): Promise<Workbook> {
  await typeInCell(page, 'A1', 'hello')
  await typeInCell(page, 'A2', '=LEN(A1)')
  await selectCell(page, 'A1')
  await page.getByRole('button', { name: '粗体' }).click()
  await saveAndWait(page)
  const saved = (await savedContent(page, documentId)).snapshot
  expect(cellOf(saved, 'A1')?.v).toBe('hello')
  expect(cellOf(saved, 'A2')).toMatchObject({ f: '=LEN(A1)', v: 5 })
  const style = cellOf(saved, 'A1')?.s
  expect(typeof style === 'string' ? saved.styles[style] : style).toMatchObject({ bl: 1 })
  return saved
}

/**
 * 重开之后不做修改立即再保存一次：本页上传的（捕获的）值、公式与格式与重开之前保存的相同，说明页面打开的就是它。
 * 看上传的正文、不看服务器上的（M3-P3 设计 §3.11）：服务端判为内容相同（§3.7），回答 unchanged、修订号不变、不存这次的字节——
 * 比较的确实是本页捕获的内容（审查 B7 当初要排除的"其实没有保存"，现在由回答里的 unchanged 与上传的正文排除）
 */
async function contentAfterResave(page: Page, documentId: string): Promise<ReturnType<typeof contentOf>> {
  const before = (await savedContent(page, documentId)).revision
  const { uploaded, answer } = await saveAndCapture(page)
  expect(answer).toMatchObject({ revision: before, unchanged: true })
  expect((await savedContent(page, documentId)).revision).toBe(before)
  return contentOf(JSON.parse(uploaded) as Workbook)
}

test.describe('US-M1-06 重开看到最后一次保存的内容', () => {
  test('保存后刷新：值、公式与格式一致，打开到 steady 之后仍是已保存', async ({ page }) => {
    await loginThroughApi(page, await createUser('reopen-refresh'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const saved = await editAndSave(page, documentId)
    await reloadAndEnterEditing(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await contentAfterResave(page, documentId)).toEqual(contentOf(saved))
  })

  test('退出后重新登录：内容一致', async ({ page }) => {
    const owner = await createUser('reopen-relogin')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const saved = await editAndSave(page, documentId)
    await page.getByRole('link', { name: '我的空间' }).click()
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
    await loginThroughUi(page, owner)
    await page.getByRole('list', { name: '文档列表' }).getByRole('link').first().click()
    await waitForEditorAccess(page, 'read')
    await enterEditing(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await contentAfterResave(page, documentId)).toEqual(contentOf(saved))
  })

  test('没有保存的修改：离开之后不出现', async ({ page }) => {
    await loginThroughApi(page, await createUser('reopen-unsaved'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const saved = await editAndSave(page, documentId)
    await typeInCell(page, 'B1', 'not saved')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    // 离开提示里选择离开
    page.once('dialog', dialog => void dialog.accept())
    await reloadAndEnterEditing(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await contentAfterResave(page, documentId)).toEqual(contentOf(saved))
  })

  test('重开时就绪之前改不了批注：悬停不弹出浮层、键入无效；就绪之后悬停照常弹出（Codex 评审 CX1，独立复验 N1）', async ({ page }) => {
    await loginThroughApi(page, await createUser('reopen-note'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    // 先加一条批注并保存：Univer 的批注浮层挂在 body 下，不在编辑器的容器里
    await selectCell(page, 'D4', { button: 'right' })
    await page.getByRole('button', { name: '添加批注' }).click()
    await page.getByRole('textbox', { name: '在此输入' }).click()
    await page.keyboard.type('original')
    // 点别处，批注写入（之后才算修改）
    await selectCell(page, 'F8')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await saveAndWait(page)
    const note = async (): Promise<unknown> => resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_NOTE_PLUGIN')
    expect(await note()).toMatchObject({ 'sheet-1': { 3: { 3: { note: 'original' } } } })

    // 拦住公式 Worker 的脚本再重开：表格画出来了，编辑器停在载入中。
    // 先离开、等编辑权释放之后再装拦截（M3-P1）：WebKit 装了 page.route 之后，导航离开、刷新时的释放发不出去，重开的页面就只能阅读（support/sheet.ts 的 leaveEditor）
    await leaveEditor(page, documentId)
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/assets/formula.worker-*.js', async (route) => {
      await released
      await route.continue()
    })
    // 与新建之后的跳转一样带 ?edit=new：直接以可编辑创建，载入中的是能编辑的编辑器——拦住输入的只有交互屏障。
    // 不带它时载入的是只读的编辑器，"内容不变"光靠只读守卫就成立，这条用例就验不到屏障了（审查 A8，create.spec 同一个做法）
    await page.goto(`/documents/${documentId}?edit=new`)
    await expect(sheetCanvas(page)).toBeVisible({ timeout: 30_000 })
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'loading')
    await expect(editorSurface(page)).toHaveAttribute('data-editor-access', 'edit')
    const noteEditor = page.getByRole('textbox', { name: '在此输入' })
    await hoverCell(page, 'D4', { force: true })
    // 悬停之后浮层几百毫秒内就会弹出：等 1 秒没有弹出才算拦住了
    const popped = await noteEditor.waitFor({ state: 'visible', timeout: 1_000 }).then(() => true, () => false)
    expect(popped).toBe(false)
    await page.keyboard.type('EDITED-DURING-LOADING')
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'loading')

    release()
    // 就绪之后直接是编辑：载入期间的键入没有进到表格里，打开不算修改
    await waitForEditorAccess(page, 'edit', 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    // 就绪之后悬停照常弹出，内容没变；保存之后服务器上也没变
    await hoverCell(page, 'D4')
    await expect(noteEditor).toBeVisible()
    await expect(noteEditor).toHaveValue('original')
    await saveAndWait(page)
    expect(await note()).toMatchObject({ 'sheet-1': { 3: { 3: { note: 'original' } } } })
  })

  test('重开时就绪之前按 Tab 与 Ctrl/Cmd+R：浏览器照常处理，表格收不到，内容不变（第二轮复验）', async ({ page }) => {
    await loginThroughApi(page, await createUser('reopen-keys'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', 'X')
    await typeInCell(page, 'B1', 'keep')
    await saveAndWait(page)

    // 先离开、等编辑权释放之后再装拦截（M3-P1）：WebKit 装了 page.route 之后，导航离开、刷新时的释放发不出去，重开的页面就只能阅读（support/sheet.ts 的 leaveEditor）
    await leaveEditor(page, documentId)
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/assets/formula.worker-*.js', async (route) => {
      await released
      await route.continue()
    })
    // 带 ?edit=new：载入中的是能编辑的编辑器，按键传给它就会改内容（审查 A8，见上一条）
    await page.goto(`/documents/${documentId}?edit=new`)
    await expect(sheetCanvas(page)).toBeVisible({ timeout: 30_000 })
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'loading')
    await expect(editorSurface(page)).toHaveAttribute('data-editor-access', 'edit')
    // 在 Univer 的快捷键里，Tab 是选区右移（A1 到 B1），Ctrl/Cmd+R 是向右填充（B1 被 A1 覆盖）：都不能传给它。
    // 浏览器可能照常刷新页面：刷新之后仍停在载入中，下面照样等就绪
    await page.keyboard.press('Tab')
    await page.keyboard.press('ControlOrMeta+R')

    release()
    await waitForEditorAccess(page, 'edit', 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    // Tab 把焦点移出了表格的输入框：就绪之后点单元格照常能键入
    await typeInCell(page, 'C1', 'after')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await saveAndWait(page)
    const saved = (await savedContent(page, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'B1')?.v, cellOf(saved, 'C1')?.v]).toEqual(['X', 'keep', 'after'])
  })
})
