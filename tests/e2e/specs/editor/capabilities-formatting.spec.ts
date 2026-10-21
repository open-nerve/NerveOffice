// US-M5-01/04：内容和格式经过公开 UI、逐项历史与服务器正文，不用 Facade 代替入口。
import type { Locator, Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { expect, test } from '../../support/fixtures.ts'
import { deleteDrawingKey, pressUniverShortcut } from '../../support/keyboard.ts'
import { formulaBarEditor, formulaBarInput, grantClipboard } from '../../support/read-only-checks.ts'
import { cellBounds, committedWorkbook, finishCapabilitySheet, historyStep, openCapabilitySheet, selectAddress } from '../../support/sheet-capabilities.ts'
import { appendSheet, cellOf, EDITOR_TEST_TIMEOUT, ribbon, savedContent, sheetCanvas, sheetTab } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function typeAddress(page: Page, address: string, value: string): Promise<void> {
  await selectAddress(page, address)
  await page.keyboard.type(value)
  await page.keyboard.press('Enter')
}

function style(workbook: Workbook, address: string): Record<string, unknown> {
  const value = cellOf(workbook, address)?.s
  if (typeof value === 'string')
    return workbook.styles[value] ?? {}
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

async function clickVisible(target: Locator): Promise<void> {
  await expect(target).toBeVisible()
  await target.click()
}

test('US-M5-01 键入、编辑栏、键盘复制剪切粘贴、清空和拖动填充逐项可撤销', async ({ page, context, browserName }) => {
  const actors = await openCapabilitySheet(page, 'cap-content')
  const id = actors.documentId
  await grantClipboard(context, browserName)
  await appendSheet(page)
  await typeAddress(page, 'A1', 'sibling')
  await sheetTab(page, '工作表1').click()
  const addresses = ['A1', 'B1', 'C1', 'D1', 'B2', 'B3', 'B4']
  const values = (book: Workbook) => addresses.map(address => cellOf(book, address)?.v ?? null)
  await historyStep(page, id, '键入单元格', values, async () => typeAddress(page, 'A1', 'typed'), ['typed', null, null, null, null, null, null])
  await historyStep(page, id, '从编辑栏输入', values, async () => {
    await selectAddress(page, 'B1')
    await formulaBarEditor(page).click()
    await expect(formulaBarInput(page)).toBeFocused()
    await page.keyboard.type('bar-entry')
    await page.keyboard.press('Enter')
  }, ['typed', 'bar-entry', null, null, null, null, null])
  await historyStep(page, id, '复制与粘贴保留源格', values, async () => {
    await selectAddress(page, 'A1')
    await pressUniverShortcut(page, 'C')
    await selectAddress(page, 'C1')
    await page.keyboard.press('ControlOrMeta+V')
  }, ['typed', 'bar-entry', 'typed', null, null, null, null])
  await historyStep(page, id, '编辑栏之后覆盖已有单元格仍保持输入顺序', values, async () => typeAddress(page, 'C1', 'cut-value'), ['typed', 'bar-entry', 'cut-value', null, null, null, null])
  await historyStep(page, id, '剪切粘贴移动值', values, async () => {
    await selectAddress(page, 'C1')
    await pressUniverShortcut(page, 'X')
    await selectAddress(page, 'D1')
    await page.keyboard.press('ControlOrMeta+V')
  }, ['typed', 'bar-entry', null, 'cut-value', null, null, null])
  await historyStep(page, id, '清空单元格', values, async () => {
    await selectAddress(page, 'D1')
    await page.keyboard.press(await deleteDrawingKey(page))
  }, ['typed', 'bar-entry', null, null, null, null, null])
  await typeAddress(page, 'B2', 'fill-source')
  await historyStep(page, id, '拖动填充柄到第四行', values, async () => {
    await selectAddress(page, 'B2')
    const snapshot = (await savedContent(page, id)).snapshot
    const from = cellBounds(snapshot, 'B2')
    const to = cellBounds(snapshot, 'B4')
    const origin = await sheetCanvas(page).boundingBox()
    if (origin === null)
      throw new Error('主画布不可见')
    await page.mouse.move(origin.x + from.endX - 1, origin.y + from.endY - 1)
    await page.mouse.down()
    await page.mouse.move(origin.x + from.endX - 1, origin.y + to.endY - 2, { steps: 8 })
    await page.mouse.up()
  }, ['typed', 'bar-entry', null, null, 'fill-source', 'fill-source', 'fill-source'])
  const result = await committedWorkbook(page, id)
  expect(cellOf(result, 'A1', result.sheetOrder[1])?.v).toBe('sibling')
  await finishCapabilitySheet(page, actors, 'bar-entry')
})

test('US-M5-01 粗斜体、字号、文字颜色、对齐、换行和数字格式逐项保留历史与值', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-style')
  const id = actors.documentId
  await typeAddress(page, 'A1', 'style-marker')
  await typeAddress(page, 'B1', '0.25')
  const home = await ribbon(page, '开始')
  const property = (key: string) => (book: Workbook) => style(book, 'A1')[key] ?? null
  const button = (name: string) => home.getByRole('button', { name, exact: true })
  for (const [label, key] of [['粗体', 'bl'], ['斜体', 'it']] as const) {
    await historyStep(page, id, label, property(key), async () => {
      await selectAddress(page, 'A1')
      await clickVisible(button(label))
    }, 1)
  }
  await historyStep(page, id, '字号改为18', property('fs'), async () => {
    await selectAddress(page, 'A1')
    const input = home.locator('[data-u-command="sheet.command.set-range-fontsize"]').getByRole('textbox')
    await expect(input).toBeVisible()
    await input.fill('18')
    await input.press('Enter')
  }, 18)
  await historyStep(page, id, '选择红色文字', book => (style(book, 'A1').cl as { rgb?: string } | undefined)?.rgb?.toUpperCase() ?? null, async () => {
    await selectAddress(page, 'A1')
    const color = home.locator('[data-u-command="sheet.command.set-range-text-color"]')
    // BUTTON_SELECTOR 的右侧箭头打开选色，不执行左侧的当前颜色按钮。
    await clickVisible(color.locator('[data-slot="dropdown-menu-trigger"]'))
    await clickVisible(page.locator('[data-u-comp="color-picker-presets"] button[style*="rgb(240, 82, 82)"]'))
  }, '#F05252')
  await historyStep(page, id, '水平居中', property('ht'), async () => {
    await selectAddress(page, 'A1')
    await clickVisible(button('水平对齐'))
    await clickVisible(page.getByRole('menuitem', { name: '中间对齐', exact: true }))
  }, 2)
  await historyStep(page, id, '自动换行', property('tb'), async () => {
    await selectAddress(page, 'A1')
    await clickVisible(button('文本换行'))
    await clickVisible(page.getByRole('menuitem', { name: '自动换行', exact: true }))
  }, 3)
  await historyStep(page, id, '数字格式百分比', book => ({ value: cellOf(book, 'B1')?.v, pattern: (style(book, 'B1').n as { pattern?: string } | undefined)?.pattern ?? null }), async () => {
    await selectAddress(page, 'B1')
    await clickVisible(button('百分比'))
  }, { value: 0.25, pattern: '0%' })
  const result = await committedWorkbook(page, id)
  expect(cellOf(result, 'A1')?.v).toBe('style-marker')
  await finishCapabilitySheet(page, actors, 'style-marker')
})

test('US-M5-01 合并与取消合并均可独立撤销，保存重开仍保留原值', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-merge')
  const id = actors.documentId
  await typeAddress(page, 'A1', 'merge-marker')
  const home = await ribbon(page, '开始')
  const merges = (book: Workbook) => ((book.sheets['sheet-1'] as { mergeData?: { startRow: number, endRow: number, startColumn: number, endColumn: number }[] }).mergeData ?? []).map(({ startRow, endRow, startColumn, endColumn }) => ({ startRow, endRow, startColumn, endColumn }))
  const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }
  await historyStep(page, id, '全部合并 A1:B2', merges, async () => {
    await selectAddress(page, 'A1:B2')
    await clickVisible(home.getByRole('button', { name: '合并单元格', exact: true }))
    await clickVisible(page.getByRole('menuitem', { name: '全部合并', exact: true }))
  }, [range])
  await historyStep(page, id, '取消合并 A1:B2', merges, async () => {
    await selectAddress(page, 'A1:B2')
    await clickVisible(home.getByRole('button', { name: '合并单元格', exact: true }))
    await clickVisible(page.getByRole('menuitem', { name: '取消合并', exact: true }))
  }, [])
  expect(cellOf(await committedWorkbook(page, id), 'A1')?.v).toBe('merge-marker')
  await finishCapabilitySheet(page, actors, 'merge-marker')
})
