// 自动保存接上页面之后的冒烟（M3-P4 S4；完整的 US-M3-02、03 用例在 S6）：放开之后停 2 秒自动上传、切到后台立即上传、
// pagehide 有在途的保存不释放编辑权、带"公式待更新"的文档进入编辑时强制重算并补存、DEF-020 的回归、面板的防抖（退出编辑之前先写进模型）。
// 节奏经测试构建的自动保存控制（support/autosave.ts）与 Playwright 的时钟（page.clock）把握，不等真实的 2 秒（规范 §8.1）；
// 控制只在测试构建里：标签 @test-build。
import type { Page, Request } from '@playwright/test'
import { SHEET_TEMPLATE } from '@nerve-office/contracts'
import { autosaveLog, clearAutosaveLog, releaseAutosave, setAutosaveLimits, uploadsOf } from '../../support/autosave.ts'
import { createDocument, createUser, editLeaseEndReason, revisionOf, withDatabase } from '../../support/database.ts'
import { commandMark, waitForCommand } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, exitEditButton, exitEditing, openAndEnterEditing, openReader, resourceOf, ribbon, saveButton, savedContent, saveStatus, selectCell, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const FIRST_SHEET = 'sheet-1'

/** 这个页面发出的保存（PUT 内容）与释放编辑权（DELETE 编辑租约） */
function recordWrites(page: Page, documentId: string) {
  const saves: Request[] = []
  const releases: Request[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'PUT' && path === `/api/documents/${documentId}/content`)
      saves.push(request)
    if (request.method() === 'DELETE' && path === `/api/documents/${documentId}/edit-lease`)
      releases.push(request)
  })
  return { saves, releases }
}

/** 页面隐藏或回到前台：改写可见性并派发 visibilitychange（Playwright 的页面一直可见；页面按 document.visibilityState 判断） */
async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

async function openNewSheet(page: Page, prefix: string, stage: 'ready' | 'steady' = 'ready'): Promise<string> {
  await loginThroughApi(page, await createUser(prefix))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId, stage)
  return documentId
}

/** 文档的"公式待更新"（服务端记在文档上，M3-P3） */
async function formulasPendingOf(documentId: string): Promise<boolean | undefined> {
  return withDatabase(async client => (await client.query<{ formulas_pending: boolean }>('SELECT formulas_pending FROM documents WHERE id = $1', [documentId])).rows[0]?.formulas_pending)
}

/** A1 是 1，A2 是 =A1*2 而缓存值是错的（上次保存时公式还没算完）：按定义 A2 = 2 */
function staleFormulas(unitId: string): string {
  const sheet = SHEET_TEMPLATE.sheets[FIRST_SHEET]
  const cellData = { 0: { 0: { v: 1, t: 2 } }, 1: { 0: { f: '=A1*2', v: 999, t: 2 } } }
  return JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { [FIRST_SHEET]: { ...sheet, cellData } } })
}

test.describe('US-M3-02 修改自动保存（S4 冒烟）', { tag: '@test-build' }, () => {
  test('放开定时的自动保存：修改停下 2 秒之后自动上传（没按保存），不到 2 秒不传；页头随之回到已保存到云端', async ({ page }) => {
    // 打开之前装上 Playwright 的时钟（时间照常流动，页面照常载入、渲染）；改完之后停住时间，按需往前拨
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-quiet')
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    await typeInCell(page, 'A1', 'auto')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10))
    await page.clock.runFor(1_500)
    expect(writes.saves).toHaveLength(0)
    expect(uploadsOf(await autosaveLog(page))).toEqual([])
    await page.clock.runFor(700)
    await expect.poll(() => writes.saves.length).toBe(1)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await page.clock.resume()
    const uploads = uploadsOf(await autosaveLog(page))
    expect(uploads).toMatchObject([{ trigger: 'quiet', outcome: { kind: 'saved' } }])
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('auto')
  })

  test('切到后台（visibilitychange 变成 hidden）：立即上传——暂停定时的上传时也照常，不等计时器；回到前台不重复', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-hidden')
    const writes = recordWrites(page, documentId)
    await typeInCell(page, 'A1', 'background')
    await clearAutosaveLog(page)
    await setPageHidden(page, true)
    await expect.poll(() => writes.saves.length).toBe(1)
    await expect.poll(async () => uploadsOf(await autosaveLog(page))).toMatchObject([{ trigger: 'hidden', outcome: { kind: 'saved' } }])
    await setPageHidden(page, false)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(writes.saves).toHaveLength(1)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('background')
  })

  test('页面关闭（pagehide）时有保存在途：不释放编辑权（让它到期，免得释放先提交、那次保存被拒）；没有在途的保存时照旧释放', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-pagehide')
    const writes = recordWrites(page, documentId)
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/api/documents/${documentId}/content?*`, async (route) => {
      if (route.request().method() === 'PUT')
        await released
      await route.continue()
    })
    await typeInCell(page, 'A1', 'in flight')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存中…')
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    // 让释放有机会发出（它是同步发起的 keepalive 请求）：没有发
    await expect(saveStatus(page)).toHaveText('保存中…')
    expect(writes.releases).toHaveLength(0)
    release()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    // 编辑权还在（没有明确结束）：那次保存照常提交了
    expect(await editLeaseEndReason(documentId)).toBeNull()
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('in flight')
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await expect.poll(() => writes.releases.length).toBe(1)
    await expect.poll(async () => editLeaseEndReason(documentId)).toBe('released')
  })
})

test.describe('US-M3-03 保存下来的公式结果与重新计算的一致（S4 冒烟）', { tag: '@test-build' }, () => {
  test('带"公式待更新"的文档：阅读页说明；进入编辑时强制全量重算，算完之后自动补存（没改也存一次），服务端清掉标记，存下的是重算的结果', async ({ page }) => {
    const owner = await createUser('autosave-forced')
    const documentId = await createDocument(owner, '公式待更新', staleFormulas)
    await withDatabase(async client => client.query('UPDATE documents SET formulas_pending = true WHERE id = $1', [documentId]))
    await loginThroughApi(page, owner)
    await openReader(page, documentId)
    const info = page.locator('#editor-chrome [data-slot="status-region"]')
    await expect(info).toContainText('这份表格的公式结果可能还没更新（上次保存时公式还没算完），进入编辑之后会自动重算并保存')

    const writes = recordWrites(page, documentId)
    await enterEditing(page)
    await releaseAutosave(page)
    // 补存不等用户的修改：公式收齐就补捕获，照上传的规则上传（没有修改时不等静默）
    await expect.poll(() => writes.saves.length).toBe(1)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(new URL(writes.saves[0]?.url() ?? '').searchParams.get('formulasPending')).toBe('false')
    const saved = (await savedContent(page, documentId)).snapshot
    expect(cellOf(saved, 'A2')).toMatchObject({ f: '=A1*2', v: 2 })
    expect(await formulasPendingOf(documentId)).toBe(false)
    expect(await revisionOf(documentId)).toBe(2)
    expect(uploadsOf(await autosaveLog(page))).toMatchObject([{ outcome: { kind: 'saved' } }])

    await exitEditing(page)
    await expect(info).not.toContainText('公式结果可能还没更新')
  })

  test('DEF-020：Cmd/Ctrl+K 被入口守卫取消之后（执行栈里留着它）改公式的依赖，自动保存存下的公式值正确', async ({ page }) => {
    // 快捷键要等 SDK 到 steady（之前不可用）
    const documentId = await openNewSheet(page, 'autosave-def020', 'steady')
    await typeInCell(page, 'A1', '1')
    await typeInCell(page, 'A2', '=A1*2')
    // 入口守卫取消插入超链接（M5 之前没有它）：被取消的命令留在 SDK 的执行栈里，之后命令之外的 mutation（Worker 的写回等）带上它的 trigger
    await selectCell(page, 'C3')
    const mark = await commandMark(page)
    await page.keyboard.press('ControlOrMeta+k')
    await waitForCommand(page, mark, { phase: 'before', id: 'sheet.operation.insert-hyper-link-toolbar', canceled: true })
    // 节奏调快（规则照旧：静默、公式收齐才捕获），不等真实的 2 秒
    await setAutosaveLimits(page, { captureQuietMs: 100, uploadQuietMs: 200 })
    await releaseAutosave(page)
    await clearAutosaveLog(page)
    await typeInCell(page, 'A1', '5')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await expect.poll(async () => uploadsOf(await autosaveLog(page)).filter(entry => entry.outcome.kind === 'saved').length).toBeGreaterThan(0)
    const saved = (await savedContent(page, documentId)).snapshot
    expect(cellOf(saved, 'A1')?.v).toBe(5)
    expect(cellOf(saved, 'A2')).toMatchObject({ f: '=A1*2', v: 10 })
    expect(await formulasPendingOf(documentId)).toBe(false)
  })
})

test.describe('面板的防抖：退出编辑之前先让面板里最后的改动写进模型（M3-P4 设计 §3.4、§7）', { tag: '@test-build' }, () => {
  test('批注浮层里键入之后立即退出编辑（SDK 300 ms 之后才写进批注）：服务器上有这次键入的全部文字', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-note')
    await selectCell(page, 'D4', { button: 'right' })
    await page.getByRole('button', { name: '添加批注' }).click()
    await page.getByRole('textbox', { name: '在此输入' }).click()
    await page.keyboard.type('remember')
    await exitEditButton(page).click()
    await waitForEditorAccess(page, 'read')
    const { snapshot } = await savedContent(page, documentId)
    expect(resourceOf(snapshot, 'SHEET_NOTE_PLUGIN')).toMatchObject({ [FIRST_SHEET]: { 3: { 3: { note: 'remember', row: 3, col: 3 } } } })
  })

  test('数据验证面板里改了数值之后立即退出编辑（SDK 1 秒之后才写进规则）：服务器上的规则是改过的', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-dv')
    await selectCell(page, 'C3')
    const data = await ribbon(page, '数据')
    await data.getByRole('button', { name: '数据验证' }).click()
    await page.getByRole('menuitem', { name: '新建规则' }).click()
    // 新建的规则是"数字等于 100"：把数值改成 250
    const value = page.getByRole('complementary', { name: '侧边栏' }).getByRole('textbox').last()
    await value.fill('250')
    await exitEditButton(page).click()
    await waitForEditorAccess(page, 'read')
    const { snapshot } = await savedContent(page, documentId)
    expect(resourceOf(snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({
      [FIRST_SHEET]: [{ type: 'decimal', operator: 'equal', formula1: '250', ranges: [{ startRow: 2, startColumn: 2, endRow: 2, endColumn: 2 }] }],
    })
  })
})
