// 重开看到最后一次保存的内容（US-M1-06，P4 设计 §3.10）：值、公式与格式一致；未保存的修改不出现；打开不被判定为有修改。
// 编辑器的内容画在画布上，核对重开之后的内容的办法：重开、不做修改，立即再保存一次，服务器上的内容与上一次保存的相同。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, editorSurface, hoverCell, leaveEditor, openEditor, resourceOf, saveAndWait, savedContent, saveStatus, selectCell, sheetCanvas, typeInCell, waitForEditor } from '../../support/sheet.ts'

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
 * 重开之后不做修改立即再保存一次：服务器上的值、公式与格式与重开之前保存的相同，说明页面打开的就是它。
 * 修订号加一：确实存下了本页捕获的内容，而不是没有保存（审查 B7）
 */
async function contentAfterResave(page: Page, documentId: string): Promise<ReturnType<typeof contentOf>> {
  const before = (await savedContent(page, documentId)).revision
  await saveAndWait(page)
  const after = await savedContent(page, documentId)
  expect(after.revision).toBe(before + 1)
  return contentOf(after.snapshot)
}

test.describe('US-M1-06 重开看到最后一次保存的内容', () => {
  test('保存后刷新：值、公式与格式一致，打开到 steady 之后仍是已保存', async ({ page }) => {
    await loginThroughApi(page, await createUser('reopen-refresh'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const saved = await editAndSave(page, documentId)
    await page.reload()
    await waitForEditor(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await contentAfterResave(page, documentId)).toEqual(contentOf(saved))
  })

  test('退出后重新登录：内容一致', async ({ page }) => {
    const owner = await createUser('reopen-relogin')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const saved = await editAndSave(page, documentId)
    await page.getByRole('link', { name: '我的空间' }).click()
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
    await loginThroughUi(page, owner)
    await page.getByRole('list', { name: '文档列表' }).getByRole('link').first().click()
    await waitForEditor(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await contentAfterResave(page, documentId)).toEqual(contentOf(saved))
  })

  test('没有保存的修改：离开之后不出现', async ({ page }) => {
    await loginThroughApi(page, await createUser('reopen-unsaved'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const saved = await editAndSave(page, documentId)
    await typeInCell(page, 'B1', 'not saved')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    // 离开提示里选择离开
    page.once('dialog', dialog => void dialog.accept())
    await page.reload()
    await waitForEditor(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await contentAfterResave(page, documentId)).toEqual(contentOf(saved))
  })

  test('重开时就绪之前改不了批注：悬停不弹出浮层、键入无效；就绪之后悬停照常弹出（Codex 评审 CX1，独立复验 N1）', async ({ page }) => {
    await loginThroughApi(page, await createUser('reopen-note'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
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
    // 先离开、等编辑权释放之后再装拦截（M3-P1）：WebKit 在拦截请求时，关闭页面时的释放发不出去，重开的页面就只能阅读（support/sheet.ts 的 leaveEditor）
    await leaveEditor(page, documentId)
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
    const noteEditor = page.getByRole('textbox', { name: '在此输入' })
    await hoverCell(page, 'D4', { force: true })
    // 悬停之后浮层几百毫秒内就会弹出：等 1 秒没有弹出才算拦住了
    const popped = await noteEditor.waitFor({ state: 'visible', timeout: 1_000 }).then(() => true, () => false)
    expect(popped).toBe(false)
    await page.keyboard.type('EDITED-DURING-LOADING')
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'loading')

    release()
    await waitForEditor(page, 'steady')
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
    await openEditor(page, documentId)
    await typeInCell(page, 'A1', 'X')
    await typeInCell(page, 'B1', 'keep')
    await saveAndWait(page)

    // 先离开、等编辑权释放之后再装拦截（M3-P1）：WebKit 在拦截请求时，关闭页面时的释放发不出去，重开的页面就只能阅读（support/sheet.ts 的 leaveEditor）
    await leaveEditor(page, documentId)
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
    // 在 Univer 的快捷键里，Tab 是选区右移（A1 到 B1），Ctrl/Cmd+R 是向右填充（B1 被 A1 覆盖）：都不能传给它。
    // 浏览器可能照常刷新页面：刷新之后仍停在载入中，下面照样等就绪
    await page.keyboard.press('Tab')
    await page.keyboard.press('ControlOrMeta+R')

    release()
    await waitForEditor(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    // Tab 把焦点移出了表格的输入框：就绪之后点单元格照常能键入
    await typeInCell(page, 'C1', 'after')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await saveAndWait(page)
    const saved = (await savedContent(page, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'B1')?.v, cellOf(saved, 'C1')?.v]).toEqual(['X', 'keep', 'after'])
  })
})
