// UR-037：画布编辑器切换焦点时不能以旧渲染光标覆盖新逻辑光标；全程使用正式 UI。
import type { Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { formulaBarEditor, formulaBarInput } from '../../support/read-only-checks.ts'
import { committedWorkbook, finishCapabilitySheet, historyStep, openCapabilitySheet, selectAddress } from '../../support/sheet-capabilities.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, openCellEditor, selectCell, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function typeInBar(page: Page, address: string, text: string): Promise<void> {
  await selectAddress(page, address)
  await formulaBarEditor(page).click()
  await expect(formulaBarInput(page)).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

for (const [label, select] of [['名称框', selectAddress], ['鼠标', selectCell]] as const) {
  test(`US-M5-01 编辑栏与单元格经${label}来回切换，原速覆盖、空白格输入、F2 追加和全选替换保留光标与历史`, async ({ page }) => {
    const actors = await openCapabilitySheet(page, 'cap-focus')
    const id = actors.documentId
    await typeInCell(page, 'A1', 'old-text')
    await typeInBar(page, 'B1', 'bar-entry')
    await historyStep(page, id, '回到已有单元格覆盖', book => cellOf(book, 'A1')?.v, async () => {
      await select(page, 'A1')
      await page.keyboard.type('new-text')
      await page.keyboard.press('Enter')
    }, 'new-text')

    await typeInBar(page, 'B2', 'second-bar')
    await historyStep(page, id, '再次返回空单元格输入', book => cellOf(book, 'C1')?.v ?? null, async () => {
      await select(page, 'C1')
      await page.keyboard.type('fresh-value')
      await page.keyboard.press('Enter')
    }, 'fresh-value')
    await historyStep(page, id, 'F2 保留正文并追加', book => cellOf(book, 'A1')?.v, async () => {
      await select(page, 'A1')
      await page.keyboard.press('F2')
      await page.keyboard.type('-tail')
      await page.keyboard.press('Enter')
    }, 'new-text-tail')
    await historyStep(page, id, '双击编辑后全选替换', book => cellOf(book, 'A1')?.v, async () => {
      await openCellEditor(page, 'A1')
      await pressUniverShortcut(page, 'A')
      await page.keyboard.type('selected-text')
      await page.keyboard.press('Enter')
    }, 'selected-text')
    const saved = await committedWorkbook(page, id)
    expect(['A1', 'B1', 'B2', 'C1'].map(address => cellOf(saved, address)?.v)).toEqual(['selected-text', 'bar-entry', 'second-bar', 'fresh-value'])
    await finishCapabilitySheet(page, actors, 'selected-text')
  })
}
