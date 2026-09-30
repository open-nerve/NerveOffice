// 保存到云端，看到真实的保存状态（US-M1-05，P4 设计 §3.7.2、§3.10）。
import type { Page } from '@playwright/test'
import { SHEET_TEMPLATE } from '@nerve-office/contracts'
import { createDocument, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { appendSheet, cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openCellEditor, openEditor, saveAndWait, saveButton, savedContent, saveStatus, selectCell, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 拦住保存的请求，直到调用返回的 release：用来观察"保存中"与保存期间的修改 */
async function holdSaves(page: Page): Promise<() => void> {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/documents/*/content?*', async (route) => {
    if (route.request().method() === 'PUT')
      await released
    await route.continue()
  })
  return release
}

/** 页面此刻会不会拦下离开（派发一次可以取消的 beforeunload，看页面有没有阻止它） */
async function wouldPromptOnLeave(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

async function openNewSheet(page: Page, prefix: string): Promise<string> {
  await loginThroughApi(page, await createUser(prefix))
  const documentId = await createSheetThroughApi(page)
  await openEditor(page, documentId)
  return documentId
}

/**
 * 计算进行中再改一次的场景（P4 探针 (f) 的公式）：E1:E1000 是 1…1000，D1 是 1、D2 是 2；A1:A300 是
 * =SUMPRODUCT($E$1:$E$1000*(ROW($E$1:$E$1000)>i))*$D$1+i，B1 是 =$D$2*2。
 * 改 D1 引起的第一轮重：300 个公式各算 1000 格（复验实测 200 个时本机 Chromium 约 0.34 秒、WebKit 约 0.2 秒），
 * 接着点选 D2 改（约 0.1–0.15 秒），第二处落在第一轮里；改 D2 引起的第二轮只算 B1。按保存之后要等的是第一轮剩下的部分加上很轻的第二轮，
 * CI 上慢几倍的 WebKit 也在公式收齐的 3 秒上限之内（原来两处都让 300 个公式重算，CI 的 WebKit 上两轮合计超过了上限）。
 * 保存不等排队的第二轮时，B1 多半是旧值（检查时第二轮已经开始的话，仍会等它算完）：这条用例看的是两处修改之后的结果，
 * "排队"的判断由"单元格还在编辑时按保存"的用例确定地锁住
 */
const SLOW_FORMULA_COUNT = 300
const E_VALUES = Array.from({ length: 1000 }, (_, row) => row + 1)

/** 按定义算出第 i 个重公式（0 起）的值：d1 是 D1 的值 */
function slowFormulaValue(d1: number, i: number): number {
  return d1 * E_VALUES.reduce((sum, value, row) => sum + (row + 1 > i ? value : 0), 0) + i
}

function sheetWithSlowFormulas(unitId: string): string {
  const cellData: Record<number, Record<number, { f?: string, v: number, t: number }>> = {}
  E_VALUES.forEach((value, row) => {
    cellData[row] = { 4: { v: value, t: 2 } }
  })
  cellData[0] = { ...cellData[0], 3: { v: 1, t: 2 }, 1: { f: '=$D$2*2', v: 4, t: 2 } }
  cellData[1] = { ...cellData[1], 3: { v: 2, t: 2 } }
  for (let i = 0; i < SLOW_FORMULA_COUNT; i += 1)
    cellData[i] = { ...cellData[i], 0: { f: `=SUMPRODUCT($E$1:$E$1000*(ROW($E$1:$E$1000)>${i}))*$D$1+${i}`, v: slowFormulaValue(1, i), t: 2 } }
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  return JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData } } })
}

test.describe('US-M1-05 保存到云端，看到真实的保存状态', () => {
  test('修改之后有未保存的修改 → 保存中 → 已保存到云端（保存按钮）', async ({ page }) => {
    const documentId = await openNewSheet(page, 'save-button')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await typeInCell(page, 'A1', '42')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    const release = await holdSaves(page)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存中…')
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
    release()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe(42)
  })

  test('单元格里键入、还没回车：已经是有未保存的修改；按 Esc 放弃，回到已保存到云端（Codex 评审 CX6）', async ({ page }) => {
    const documentId = await openNewSheet(page, 'save-cell-input')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await typeInCell(page, 'A1', 'typing', false)
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await page.keyboard.press('Escape')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await wouldPromptOnLeave(page)).toBe(false)

    // 双击只是打开编辑器：还是已保存到云端（离开时照样提示，编辑器开着）；键入之后才是有未保存的修改
    await openCellEditor(page, 'B2')
    await expect.poll(async () => wouldPromptOnLeave(page)).toBe(true)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await page.keyboard.type('x')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    // 保存时先提交编辑（等同回车），服务器上是键入的内容
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'B2')?.v).toBe('x')
  })

  test('Ctrl/Cmd+S 保存（焦点在表格里也收得到），不弹出浏览器的另存网页', async ({ page }) => {
    const documentId = await openNewSheet(page, 'save-shortcut')
    // 在页面的监听之后再挂一个捕获阶段的监听，记下按键事件的默认行为是否已被阻止（无头浏览器本来就不弹出另存网页，只能这样核对，审查 B7）
    await page.evaluate(() => {
      const seen: boolean[] = []
      Object.assign(window, { saveShortcutPrevented: seen })
      window.addEventListener('keydown', (event) => {
        if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey))
          seen.push(event.defaultPrevented)
      }, { capture: true })
    })
    await typeInCell(page, 'B2', 'shortcut')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'B2')?.v).toBe('shortcut')
    expect(await page.evaluate(() => (window as unknown as { saveShortcutPrevented: boolean[] }).saveShortcutPrevented)).toEqual([true])
  })

  test('保存期间继续键入：回包之后仍是有未保存的修改，服务器上是保存那一刻的内容', async ({ page }) => {
    const documentId = await openNewSheet(page, 'save-while-typing')
    await typeInCell(page, 'A1', 'first')
    const release = await holdSaves(page)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存中…')
    await typeInCell(page, 'A2', 'second')
    release()
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    const saved = (await savedContent(page, documentId)).snapshot
    expect(cellOf(saved, 'A1')?.v).toBe('first')
    expect(cellOf(saved, 'A2')).toBeUndefined()
    await page.unrouteAll()
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A2')?.v).toBe('second')
  })

  test('断网时保存：显示保存失败与原因，内容仍算未保存；恢复之后再保存成功', async ({ page, context }) => {
    const documentId = await openNewSheet(page, 'save-offline')
    await typeInCell(page, 'A1', 'offline')
    await context.setOffline(true)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存失败')
    await expect(page.getByRole('alert')).toHaveText('保存失败：网络连接失败，请检查网络后重试')
    await context.setOffline(false)
    await saveAndWait(page)
    await expect(page.getByRole('alert')).toBeHidden()
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('offline')
  })

  test('单元格还在编辑时按保存：依赖它的公式的缓存值是提交之后的结果（公式收齐的"排队"判断，复验 RB5）', async ({ page }) => {
    // 提交写入的修改让下一轮计算排队；紧接着第一次判断是否收齐时，SDK 的防抖还没过、新的一轮还没开始，只有"排队"挡得住过早的捕获
    const documentId = await openNewSheet(page, 'save-editing-formula')
    await typeInCell(page, 'A1', '1')
    await typeInCell(page, 'A2', '=A1*2')
    await saveAndWait(page)
    await typeInCell(page, 'A1', '5', false)
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    const saved = (await savedContent(page, documentId)).snapshot
    expect(cellOf(saved, 'A1')?.v).toBe(5)
    expect(cellOf(saved, 'A2')).toMatchObject({ f: '=A1*2', v: 10 })
  })

  test('单元格还在编辑时按保存：内容先提交再保存', async ({ page }) => {
    const documentId = await openNewSheet(page, 'save-while-editing')
    await typeInCell(page, 'C3', 'typing', false)
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'C3')?.v).toBe('typing')
  })

  test('有未保存的修改时离开：浏览器提示；保存之后离开不提示', async ({ page, context }) => {
    await openNewSheet(page, 'save-leave')
    await typeInCell(page, 'A1', 'unsaved')
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type())
      void dialog.dismiss()
    })
    await page.close({ runBeforeUnload: true })
    await expect.poll(() => dialogs).toEqual(['beforeunload'])
    expect(page.isClosed()).toBe(false)

    await saveAndWait(page)
    const closed = new Promise<void>(resolve => page.once('close', () => resolve()))
    await page.close({ runBeforeUnload: true })
    await closed
    expect(dialogs).toEqual(['beforeunload'])
    expect(context.pages()).not.toContain(page)
  })

  test('改了公式的依赖立即保存：服务器上公式的缓存值与按定义算出的一致', async ({ page }) => {
    const documentId = await openNewSheet(page, 'save-formulas')
    await typeInCell(page, 'A1', '1')
    await typeInCell(page, 'A2', '=A1*2')
    await typeInCell(page, 'A3', '=SUM(A1:A2)')
    await saveAndWait(page)
    // 改依赖之后不等，立即保存：保存要等公式收齐
    await typeInCell(page, 'A1', '5')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    const saved = (await savedContent(page, documentId)).snapshot
    expect(cellOf(saved, 'A2')).toMatchObject({ f: '=A1*2', v: 10 })
    expect(cellOf(saved, 'A3')).toMatchObject({ f: '=SUM(A1:A2)', v: 15 })
  })

  test('计算进行中又改了一处，立即保存：等第二轮算完才保存，服务器上的缓存值是两处修改之后的结果', async ({ page }) => {
    const owner = await createUser('save-during-calculation')
    const documentId = await createDocument(owner, '计算中再改', sheetWithSlowFormulas)
    await loginThroughApi(page, owner)
    await openEditor(page, documentId, 'steady')
    // 两处的脏区不相交，SDK 不停下这一轮，而是算完之后再开始下一轮（录制的序列见单元测试的 EDIT_DURING_CALCULATION）
    await typeInCell(page, 'D1', '1000')
    await typeInCell(page, 'D2', '2000')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await expect(page.getByText('公式结果尚未保存，请稍后再保存一次')).toHaveCount(0)

    const saved = (await savedContent(page, documentId)).snapshot
    const values = Array.from({ length: SLOW_FORMULA_COUNT }, (_, row) => saved.sheets['sheet-1']?.cellData[row]?.[0]?.v)
    expect(values).toEqual(Array.from({ length: SLOW_FORMULA_COUNT }, (_, i) => slowFormulaValue(1000, i)))
    // 第二轮（排队的那一轮）的结果
    expect(cellOf(saved, 'B1')?.v).toBe(4000)
  })

  test('编辑中的公式引用了另一张表时按保存：先提交、等写入，再保存，服务器上有这次的公式（第二轮复验）', async ({ page }) => {
    const documentId = await openNewSheet(page, 'save-cross-edit')
    await appendSheet(page)
    await expect(page.getByRole('tab', { name: '工作表2' })).toHaveAttribute('aria-selected', 'true')
    await typeInCell(page, 'B2', '5')
    await page.getByRole('tab', { name: '工作表1' }).click()
    // 在工作表1 的 A1 键入 =，点工作表2 的标签、再点它的 B2 选作引用：提交时 SDK 先切回工作表1（4 毫秒的定时器）再写入
    await typeInCell(page, 'A1', '=', false)
    await page.getByRole('tab', { name: '工作表2' }).click()
    await selectCell(page, 'B2')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    const saved = (await savedContent(page, documentId)).snapshot
    const first = saved.sheetOrder.find(id => saved.sheets[id]?.name === '工作表1') ?? ''
    expect(cellOf(saved, 'A1', first)).toMatchObject({ f: '=工作表2!B2', v: 5 })
  })

  test('跨表引用：改了另一张表的依赖立即保存，缓存值一致', async ({ page }) => {
    const documentId = await openNewSheet(page, 'save-cross-sheet')
    await typeInCell(page, 'A1', '3')
    // 加第二张表（成为当前的表），在它的 A1 引用第一张表
    await appendSheet(page)
    await expect(page.getByRole('tab', { name: '工作表2' })).toHaveAttribute('aria-selected', 'true')
    await typeInCell(page, 'A1', '=工作表1!A1+1')
    await page.getByRole('tab', { name: '工作表1' }).click()
    await typeInCell(page, 'A1', '7')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    const saved = (await savedContent(page, documentId)).snapshot
    const second = saved.sheetOrder.find(id => saved.sheets[id]?.name === '工作表2') ?? ''
    expect(cellOf(saved, 'A1', second)).toMatchObject({ v: 8 })
    expect(cellOf(saved, 'A1', second)?.f).toBe('=工作表1!A1+1')
  })
})
