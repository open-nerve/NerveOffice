// US-M5-04：备注与查找替换通过真实 UI、服务器内容和逐项历史验证。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { contentOf, nameBox } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { committedWorkbook, finishCapabilitySheet, historyStep, openCapabilitySheet, selectAddress } from '../../support/sheet-capabilities.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, hoverCell, resourceOf, ribbon, savedContent, selectCell, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

function noteOf(book: Workbook) {
  const resource = resourceOf(book, 'SHEET_NOTE_PLUGIN') as Record<string, Record<string, Record<string, { note: string, show?: boolean }>>>
  return resource['sheet-1']?.[3]?.[3]
}

async function noteMenu(page: Page, label: string): Promise<void> {
  await selectCell(page, 'D4', { button: 'right' })
  await page.getByRole('button', { name: label, exact: true }).click()
}

async function addNote(page: Page, text: string): Promise<void> {
  await noteMenu(page, '添加批注')
  await page.getByRole('textbox', { name: '在此输入' }).fill(text)
  await selectCell(page, 'F8')
}

test('US-M5-04 备注新增、修改、显示隐藏和删除分别可撤销，重开与查看者仍能读到', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-note')
  const id = actors.documentId
  await typeInCell(page, 'D4', 'note-cell')
  const text = (book: Workbook) => noteOf(book)?.note ?? null
  await historyStep(page, id, '添加备注', text, async () => addNote(page, 'first note'), 'first note')
  await historyStep(page, id, '修改已有备注', text, async () => {
    await hoverCell(page, 'D4')
    const input = page.getByRole('textbox', { name: '在此输入' })
    await expect(input).toHaveValue('first note')
    await input.fill('updated note')
    await selectCell(page, 'F8')
  }, 'updated note')
  const shown = (book: Workbook) => noteOf(book)?.show === true
  const initial = shown(await committedWorkbook(page, id))
  await historyStep(page, id, '切换备注常驻显示', shown, async () => noteMenu(page, '显示/隐藏批注'), !initial)
  await historyStep(page, id, '再次切换备注显示', shown, async () => noteMenu(page, '显示/隐藏批注'), initial)
  await historyStep(page, id, '删除备注', text, async () => noteMenu(page, '删除批注'), null)
  await historyStep(page, id, '重新添加供重开验证', text, async () => addNote(page, 'retained note'), 'retained note')
  expect(cellOf(await committedWorkbook(page, id), 'D4')?.v).toBe('note-cell')
  await finishCapabilitySheet(page, actors, 'note-cell')
  await hoverCell(page, 'D4')
  const input = page.getByRole('textbox', { name: '在此输入' })
  await expect(input).toHaveValue('retained note')
  await expect(input).toHaveAttribute('readonly', '')
})

async function findDialog(page: Page, replacement?: string) {
  await selectAddress(page, 'A1')
  await (await ribbon(page, '数据')).getByRole('button', { name: '查找替换', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '查找', exact: true })
  await dialog.getByText('替换 / 高级查找', { exact: true }).click()
  if (replacement !== undefined) {
    await dialog.getByRole('textbox', { name: '输入替换内容' }).fill(replacement)
  }
  await dialog.getByRole('textbox', { name: '输入查找内容' }).fill('apple')
  await dialog.getByRole('button', { name: '查找', exact: true }).click()
  return dialog
}

test('US-M5-04 查找不修改文档，单项替换与全部替换各自可撤销并保存重开', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-find')
  const id = actors.documentId
  for (const [address, value] of [['B1', 'apple'], ['B2', 'apple pie'], ['B3', 'apple tart']])
    await typeInCell(page, address!, value!)
  await committedWorkbook(page, id)
  const before = await savedContent(page, id)
  const find = await findDialog(page)
  await expect(find).toContainText('1/3')
  await expect(nameBox(page), '查找使用独立高亮，原编辑选区保持不变').toHaveValue('A1')
  await find.getByRole('button', { name: 'Close' }).click()
  await committedWorkbook(page, id)
  const found = await savedContent(page, id)
  expect(contentOf(found.text)).toEqual(contentOf(before.text))
  expect(found.revision).toBe(before.revision)
  const values = (book: Workbook) => ['B1', 'B2', 'B3'].map(address => cellOf(book, address)?.v)
  await historyStep(page, id, '替换当前匹配', values, async () => {
    const dialog = await findDialog(page, 'banana')
    await expect(dialog).toContainText('1/3')
    await dialog.getByRole('button', { name: '替换', exact: true }).click()
    await dialog.getByRole('button', { name: 'Close' }).click()
  }, ['banana', 'apple pie', 'apple tart'])
  await historyStep(page, id, '替换其余全部匹配', values, async () => {
    const dialog = await findDialog(page, 'banana')
    await expect(dialog).toContainText(/[12]\/2/)
    await dialog.getByRole('button', { name: '替换全部', exact: true }).click()
    await page.getByRole('dialog', { name: '确定要替换所有的匹配项吗？' }).getByRole('button', { name: '确定', exact: true }).click()
    await dialog.getByRole('button', { name: 'Close' }).click()
  }, ['banana', 'banana pie', 'banana tart'])
  await finishCapabilitySheet(page, actors, 'banana tart')
})
