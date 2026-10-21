// US-M5-01/04：工作表结构、两表隔离与历史，经真实 UI 改动并核对保存重开。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { expect, test } from '../../support/fixtures.ts'
import { allSheetsMenuButton } from '../../support/read-only-checks.ts'
import { nextFrames } from '../../support/read-only.ts'
import { cellBounds, committedWorkbook, dimensions, finishCapabilitySheet, historyStep, openCapabilitySheet, selectAddress } from '../../support/sheet-capabilities.ts'
import { appendSheet, cellOf, EDITOR_TEST_TIMEOUT, savedContent, sheetCanvas, sheetTab } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

function names(workbook: Workbook): string[] {
  return workbook.sheetOrder.map(id => workbook.sheets[id]!.name)
}

async function typeAddress(page: Page, address: string, value: string): Promise<void> {
  await selectAddress(page, address)
  await page.keyboard.type(value)
  await page.keyboard.press('Enter')
}

async function sheetMenu(page: Page, name: string, item: string): Promise<void> {
  await sheetTab(page, name).click({ button: 'right' })
  await page.getByRole('button', { name: item, exact: true }).click()
}

async function headerContext(page: Page, documentId: string, address: string, axis: 'row' | 'column', selection = address): Promise<void> {
  await selectAddress(page, selection)
  const snapshot = (await savedContent(page, documentId)).snapshot
  const rect = cellBounds(snapshot, address)
  const shape = dimensions(snapshot)
  const point = axis === 'row'
    ? { x: shape.rowHeader.width / 2, y: (rect.startY + rect.endY) / 2 }
    : { x: (rect.startX + rect.endX) / 2, y: shape.columnHeader.height / 2 }
  if (selection !== address) {
    const last = cellBounds(snapshot, 'C3')
    const origin = await sheetCanvas(page).boundingBox()
    if (origin === null)
      throw new Error('主画布不可见')
    await page.mouse.move(origin.x + point.x, origin.y + point.y)
    await page.mouse.down()
    await page.mouse.move(origin.x + (axis === 'row' ? point.x : (last.startX + last.endX) / 2), origin.y + (axis === 'row' ? (last.startY + last.endY) / 2 : point.y), { steps: 6 })
    await page.mouse.up()
  }
  await sheetCanvas(page).click({ button: 'right', position: point })
}

async function dimensionMenu(page: Page, documentId: string, address: string, label: string, selection = address): Promise<void> {
  await headerContext(page, documentId, address, label.includes('列') ? 'column' : 'row', selection)
  const name = label === '在上方插入行' ? /^在上方插入/ : label === '在左侧插入列' ? /^在左侧插入/ : label
  const item = page.getByRole('button', { name, exact: typeof name === 'string' })
  await expect(item).toBeVisible()
  await item.click()
}

test('US-M5-01 工作表新增、重命名、复制、移动、隐藏显示、删除逐项可撤销并保存', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-sheets')
  const id = actors.documentId
  await typeAddress(page, 'A1', 'original-sheet')
  await historyStep(page, id, '新增工作表', names, async () => appendSheet(page), ['工作表1', '工作表2'])
  await sheetTab(page, '工作表2').click()
  await typeAddress(page, 'A1', 'second-sheet')
  await historyStep(page, id, '重命名', names, async () => {
    await sheetTab(page, '工作表2').dblclick()
    await expect(sheetTab(page, '工作表2').locator('[contenteditable="true"]')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('明细')
    await page.keyboard.press('Enter')
  }, ['工作表1', '明细'])
  await sheetTab(page, '明细').click()
  const copied = await historyStep(page, id, '复制保留本表内容且不改另一张表', book => book.sheetOrder.map(key => cellOf(book, 'A1', key)?.v), async () => sheetMenu(page, '明细', '复制'), ['original-sheet', 'second-sheet', 'second-sheet'])
  const copyName = copied.sheets[copied.sheetOrder[2]!]!.name
  await historyStep(page, id, '拖动复制表到最前', names, async () => {
    const from = await sheetTab(page, copyName).boundingBox()
    const to = await sheetTab(page, '工作表1').boundingBox()
    if (from === null || to === null)
      throw new Error('工作表标签不可见')
    const dragged = page.locator('[data-u-comp="slide-tab-item"]').filter({ hasText: copyName })
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await expect(dragged).toHaveCSS('cursor', 'move')
    await page.mouse.move(to.x + 2, to.y + to.height / 2, { steps: 10 })
    await nextFrames(page)
    await page.mouse.up()
  }, [copyName, '工作表1', '明细'])

  const visibleNames = (book: Workbook) => book.sheetOrder.filter(key => (book.sheets[key] as { hidden?: number }).hidden !== 1).map(key => book.sheets[key]!.name)
  await historyStep(page, id, '隐藏复制表', visibleNames, async () => sheetMenu(page, copyName, '隐藏'), ['工作表1', '明细'])
  await expect(sheetTab(page, copyName)).toHaveCount(0)
  await historyStep(page, id, '全部工作表菜单取消隐藏', visibleNames, async () => {
    await allSheetsMenuButton(page).click()
    await page.getByRole('menuitem', { name: copyName, exact: true }).click()
  }, [copyName, '工作表1', '明细'])
  await historyStep(page, id, '删除工作表及恢复', names, async () => {
    await sheetMenu(page, copyName, '删除')
    await page.getByRole('dialog', { name: '删除工作表' }).getByRole('button', { name: '确定' }).click()
  }, ['工作表1', '明细'])
  const result = await committedWorkbook(page, id)
  expect(result.sheetOrder.map(key => cellOf(result, 'A1', key)?.v)).toEqual(['original-sheet', 'second-sheet'])
  await finishCapabilitySheet(page, actors)
})

test('US-M5-01 行列增删、宽高、隐藏显示逐项保存与撤销，另一表保持原值', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-dimensions')
  const id = actors.documentId
  await typeAddress(page, 'A1', 'head')
  await typeAddress(page, 'B2', 'pivot')
  await typeAddress(page, 'C3', 'tail')
  await appendSheet(page)
  await typeAddress(page, 'A1', 'other-sheet')
  await sheetTab(page, '工作表1').click()
  const base = dimensions(await committedWorkbook(page, id))

  const contextAt = async (address: string, axis: 'row' | 'column') => headerContext(page, id, address, axis)
  const menu = async (address: string, label: string, selection = address) => dimensionMenu(page, id, address, label, selection)
  const values = (book: Workbook, addresses: string[]) => addresses.map(address => cellOf(book, address)?.v ?? null)
  await historyStep(page, id, '在第二行上方插入一行', book => ({ rows: dimensions(book).rowCount, values: values(book, ['A1', 'B2', 'B3', 'C4']) }), async () => menu('B2', '在上方插入行'), { rows: base.rowCount + 1, values: ['head', null, 'pivot', 'tail'] })
  await historyStep(page, id, '删除插入的空行', book => ({ rows: dimensions(book).rowCount, values: values(book, ['A1', 'B2', 'C3']) }), async () => menu('B2', '删除选中行'), { rows: base.rowCount, values: ['head', 'pivot', 'tail'] })
  await historyStep(page, id, '在第二列左侧插入一列', book => ({ columns: dimensions(book).columnCount, values: values(book, ['A1', 'B2', 'C2', 'D3']) }), async () => menu('B2', '在左侧插入列'), { columns: base.columnCount + 1, values: ['head', null, 'pivot', 'tail'] })
  await historyStep(page, id, '删除插入的空列', book => ({ columns: dimensions(book).columnCount, values: values(book, ['A1', 'B2', 'C3']) }), async () => menu('B2', '删除选中列'), { columns: base.columnCount, values: ['head', 'pivot', 'tail'] })
  await historyStep(page, id, '调整第二行行高', book => dimensions(book).rowData?.[1]?.h ?? base.defaultRowHeight, async () => {
    await contextAt('B2', 'row')
    const input = page.getByRole('button', { name: /行高/ }).getByRole('textbox')
    await expect(input).toBeVisible()
    await input.fill('40')
    // 数字框只编辑菜单的待执行参数；点击菜单项才应用，点击左端以避开内部数字框。
    await page.getByRole('button', { name: /行高/ }).click({ position: { x: 12, y: 12 } })
  }, 40)
  await historyStep(page, id, '调整第二列列宽', book => dimensions(book).columnData?.[1]?.w ?? base.defaultColumnWidth, async () => {
    await contextAt('B2', 'column')
    const input = page.getByRole('button', { name: /列宽/ }).getByRole('textbox')
    await expect(input).toBeVisible()
    await input.fill('120')
    await page.getByRole('button', { name: /列宽/ }).click({ position: { x: 12, y: 12 } })
  }, 120)
  await historyStep(page, id, '隐藏第二行', book => dimensions(book).rowData?.[1]?.hd ?? 0, async () => menu('B2', '隐藏选中行'), 1)
  await historyStep(page, id, '从跨行选区显示隐藏行', book => dimensions(book).rowData?.[1]?.hd ?? 0, async () => menu('A1', '显示隐藏行', 'A1:C3'), 0)
  await historyStep(page, id, '隐藏第二列', book => dimensions(book).columnData?.[1]?.hd ?? 0, async () => menu('B2', '隐藏选中列'), 1)
  await historyStep(page, id, '从跨列选区显示隐藏列', book => dimensions(book).columnData?.[1]?.hd ?? 0, async () => menu('A1', '显示隐藏列', 'A1:C3'), 0)
  const result = await committedWorkbook(page, id)
  expect(values(result, ['A1', 'B2', 'C3'])).toEqual(['head', 'pivot', 'tail'])
  expect(cellOf(result, 'A1', result.sheetOrder[1])?.v).toBe('other-sheet')
  await finishCapabilitySheet(page, actors)
})
