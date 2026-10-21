// US-M5-03/04：冻结、筛选和排序的实际配置、历史及保存重开。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { nameBox } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { cellBounds, committedWorkbook, finishCapabilitySheet, historyStep, openCapabilitySheet, selectAddress } from '../../support/sheet-capabilities.ts'
import { appendSheet, cellOf, EDITOR_TEST_TIMEOUT, resourceOf, ribbon, savedContent, selectCell, sheetCanvas, sheetTab, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

function freeze(book: Workbook) {
  return (book.sheets['sheet-1'] as { freeze?: unknown }).freeze
}

async function setFreeze(page: Page, label: string): Promise<void> {
  await (await ribbon(page, '视图')).getByRole('button', { name: '冻结', exact: true }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

interface FilterState {
  ref: { startRow: number, endRow: number, startColumn: number, endColumn: number }
  filterColumns?: unknown[]
  cachedFilteredOut?: number[]
}

function filterOf(book: Workbook) {
  const saved = (resourceOf(book, 'SHEET_FILTER_PLUGIN') as Record<string, FilterState>)['sheet-1']
  if (saved === undefined)
    return null
  const { startRow, endRow, startColumn, endColumn } = saved.ref
  return { ref: { startRow, endRow, startColumn, endColumn }, columns: saved.filterColumns ?? [], hidden: [...saved.cachedFilteredOut ?? []].sort((a, b) => a - b) }
}

async function filterPanel(page: Page, id: string): Promise<void> {
  await selectAddress(page, 'A1')
  const rect = cellBounds((await savedContent(page, id)).snapshot, 'A1')
  await sheetCanvas(page).click({ position: { x: rect.endX - 10, y: (rect.startY + rect.endY) / 2 } })
  await expect(page.getByRole('button', { name: '清除筛选', exact: true })).toBeVisible()
}

test('US-M5-03 冻结首行、首列与取消逐项保留历史，两张表切换和重开保持独立', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-freeze')
  const id = actors.documentId
  await typeInCell(page, 'A1', 'freeze-marker')
  await appendSheet(page)
  await typeInCell(page, 'A1', 'sibling')
  await sheetTab(page, '工作表1').click()
  const none = { startRow: -1, startColumn: -1, xSplit: 0, ySplit: 0 }
  await historyStep(page, id, '冻结首行', freeze, async () => setFreeze(page, '冻结首行'), { ...none, startRow: 1, ySplit: 1 })
  await historyStep(page, id, '改为冻结首列', freeze, async () => setFreeze(page, '冻结首列'), { ...none, startColumn: 1, xSplit: 1 })
  await historyStep(page, id, '取消冻结', freeze, async () => setFreeze(page, '取消冻结'), none)
  await historyStep(page, id, '重新冻结后切表与重开', freeze, async () => setFreeze(page, '冻结首行'), { ...none, startRow: 1, ySplit: 1 })
  await sheetTab(page, '工作表2').click()
  await sheetTab(page, '工作表1').click()
  const book = await committedWorkbook(page, id)
  expect(freeze(book)).toEqual({ ...none, startRow: 1, ySplit: 1 })
  expect((book.sheets[book.sheetOrder[1]!] as { freeze?: unknown }).freeze).toEqual(none)
  expect(cellOf(book, 'A1', book.sheetOrder[1])?.v).toBe('sibling')
  await finishCapabilitySheet(page, actors, 'freeze-marker')
})

test('US-M5-03 升序和降序实际移动完整行，撤销重做与查看者保留对应关系', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-sort')
  const id = actors.documentId
  for (const [address, value] of [['A1', 'number'], ['B1', 'label'], ['A2', '3'], ['B2', 'third'], ['A3', '1'], ['B3', 'first'], ['A4', '2'], ['B4', 'middle']])
    await typeInCell(page, address!, value!)
  const rows = (book: Workbook) => [2, 3, 4].map(row => [cellOf(book, `A${row}`)?.v, cellOf(book, `B${row}`)?.v])
  for (const [label, expected] of [['当前区域升序', [[1, 'first'], [2, 'middle'], [3, 'third']]], ['当前区域降序', [[3, 'third'], [2, 'middle'], [1, 'first']]]] as const) {
    await historyStep(page, id, label, rows, async () => {
      await selectAddress(page, 'A2:B4')
      await (await ribbon(page, '数据')).getByRole('button', { name: '排序', exact: true }).click()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
    }, expected)
  }
  const book = await committedWorkbook(page, id)
  expect([cellOf(book, 'A1')?.v, cellOf(book, 'B1')?.v]).toEqual(['number', 'label'])
  await finishCapabilitySheet(page, actors, 'middle')
})

test('US-M5-03 设置实际筛选条件、清除条件与取消筛选均保存并可撤销，隐藏行与值一致', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-filter')
  const id = actors.documentId
  for (const [address, value] of [['A1', 'amount'], ['A2', '1'], ['A3', '2'], ['A4', '3']])
    await typeInCell(page, address!, value!)
  const ref = { startRow: 0, endRow: 3, startColumn: 0, endColumn: 0 }
  const empty = { ref, columns: [], hidden: [] }
  const filtered = { ref, columns: [{ colId: 0, customFilters: { customFilters: [{ val: '1', operator: 'greaterThan' }] } }], hidden: [1] }
  const toggle = async () => {
    await selectAddress(page, 'A1:A4')
    await (await ribbon(page, '数据')).locator('[data-u-command="sheet.command.smart-toggle-filter"]').filter({ visible: true }).click()
  }
  const greaterThanOne = async () => {
    await filterPanel(page, id)
    await page.getByText('按条件', { exact: true }).click()
    const panel = page.locator('[data-u-comp="sheets-filter-panel-conditions-container"]')
    await panel.locator('[data-u-comp="select"]').first().click()
    await page.getByRole('menuitemradio', { name: '大于', exact: true }).click()
    await panel.getByPlaceholder('请输入', { exact: true }).fill('1')
    await page.locator('[data-u-comp="sheets-filter-panel-footer"]').getByRole('button', { name: '确认', exact: true }).click()
  }
  await historyStep(page, id, '开启筛选', filterOf, toggle, empty)
  await historyStep(page, id, '按数值大于1筛选', filterOf, greaterThanOne, filtered)
  await selectCell(page, 'A2')
  await expect(nameBox(page), '第二个可见行实际是A3，A2被条件排除').toHaveValue('A3')
  await historyStep(page, id, '清除筛选条件', filterOf, async () => {
    await filterPanel(page, id)
    await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  }, empty)
  await historyStep(page, id, '取消筛选', filterOf, toggle, null)
  await toggle()
  await committedWorkbook(page, id)
  await greaterThanOne()
  const book = await committedWorkbook(page, id)
  expect(filterOf(book)).toEqual(filtered)
  expect(['A2', 'A3', 'A4'].map(address => cellOf(book, address)?.v)).toEqual([1, 2, 3])
  await finishCapabilitySheet(page, actors, 'amount')
})
