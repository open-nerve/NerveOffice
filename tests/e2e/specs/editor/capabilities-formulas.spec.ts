// M5-P3-S5：M0 六类公式经正式 UI 创建，逐项历史、结构引用、重开和只读对照。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { cellBounds, committedWorkbook, dimensions, finishCapabilitySheet, historyStep, openCapabilitySheet, selectAddress } from '../../support/sheet-capabilities.ts'
import { appendSheet, cellOf, EDITOR_TEST_TIMEOUT, expectFoundOnce, resourceOf, savedContent, sheetCanvas, sheetTab } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

interface DefinedName {
  readonly name: string
  readonly formulaOrRefString: string
  readonly localSheetId: string
}

// SDK 可能省去不含空格的表名引号；只统一本测试两个名称，不改引用位置或表达式。
function reference(text: string): string {
  return text.replaceAll('\'数据\'!', '数据!').replaceAll('\'源数据\'!', '源数据!')
}

function definedNames(book: Workbook) {
  const entries = resourceOf(book, 'SHEET_DEFINED_NAME_PLUGIN') as Record<string, DefinedName> | undefined
  return Object.values(entries ?? {}).map(({ name, formulaOrRefString, localSheetId }) => ({
    name,
    ref: reference(formulaOrRefString),
    scope: localSheetId,
  }))
}

function formulaFacts(book: Workbook) {
  return {
    sheets: book.sheetOrder.map(id => book.sheets[id]!.name),
    names: definedNames(book),
    formulas: book.sheetOrder.flatMap(id => Object.entries(book.sheets[id]!.cellData).flatMap(([row, cells]) =>
      Object.entries(cells).flatMap(([col, cell]) => cell.f === undefined
        ? []
        : [{ sheet: book.sheets[id]!.name, row: Number(row), col: Number(col), f: reference(cell.f), v: cell.v }]))),
  }
}

function expectedFacts(source: string, row: number, second: number, word: string) {
  const range = `B${row}:B${row + 1}`
  return {
    sheets: [source, '汇总'],
    names: [{ name: '数量合计区', ref: `${source}!$B$${row}:$B$${row + 1}`, scope: 'AllDefaultWorkbook' }],
    formulas: [
      { sheet: source, row: row - 1, col: 2, f: `=A${row}&"-"&B${row}`, v: `${word}-3` },
      { sheet: source, row: row + 2, col: 1, f: `=SUM(${range})`, v: 3 + second },
      { sheet: source, row: row + 3, col: 1, f: `=AVERAGE(${range})`, v: (3 + second) / 2 },
      { sheet: source, row: row + 4, col: 1, f: '=SUM(数量合计区)', v: 3 + second },
      { sheet: '汇总', row: 0, col: 0, f: `=SUM(${source}!${range})`, v: 3 + second },
      { sheet: '汇总', row: 1, col: 0, f: `=${source}!A${row}`, v: word },
    ],
  }
}

async function typeAddress(page: Page, address: string, value: string): Promise<void> {
  await selectAddress(page, address)
  // 显式打开编辑器后替换正文，文本输入不依赖首个字符触发画布编辑。
  await page.keyboard.press('F2')
  await pressUniverShortcut(page, 'A')
  await page.keyboard.type(value)
  await page.keyboard.press('Enter')
}

async function renameSheet(page: Page, from: string, to: string): Promise<void> {
  await sheetTab(page, from).dblclick()
  await expect(sheetTab(page, from).locator('[contenteditable="true"]')).toBeVisible()
  // SDK 在下一任务设置改名选区和焦点；显示不代表已经能接收键盘输入。
  await expect(sheetTab(page, from).locator('[contenteditable="true"]')).toBeFocused()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(to)
  await page.keyboard.press('Enter')
  await expect(sheetTab(page, to)).toBeVisible()
}

test('US-M5-02 聚合、文本、跨表和定义名称经正式入口创建，依赖与结构变化可撤销，保存重开和查看者一致', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cap-formulas')
  const id = actors.documentId
  await appendSheet(page)
  await renameSheet(page, '工作表2', '汇总')
  await renameSheet(page, '工作表1', '数据')
  await sheetTab(page, '数据').click()
  for (const [address, value] of [['A2', '青'], ['A3', '山'], ['B2', '3'], ['B3', '4']] as const)
    await typeAddress(page, address, value)
  const inputs = await committedWorkbook(page, id)
  expect(['A2', 'A3', 'B2', 'B3'].map(address => cellOf(inputs, address)?.v)).toEqual(['青', '山', 3, 4])

  await historyStep(page, id, '名称管理器创建名称及独立历史', definedNames, async () => {
    await selectAddress(page, 'B2:B3')
    await page.locator('[data-u-comp="defined-name"]').locator('a').click()
    await page.locator('[data-u-comp="defined-name-overlay-footer"]').click()
    const manager = page.locator('[data-u-comp="defined-name-container"]')
    await manager.getByRole('button', { name: '新建名称', exact: true }).click()
    await manager.getByPlaceholder('请输入名称（必填）').fill('数量合计区')
    await manager.getByRole('button', { name: '确认', exact: true }).click()
    await expect(manager.getByText('数量合计区', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭侧边栏' }).click()
  }, expectedFacts('数据', 2, 4, '青').names)

  for (const [address, formula] of [
    ['C2', '=A2&"-"&B2'],
    ['B5', '=SUM(B2:B3)'],
    ['B6', '=AVERAGE(B2:B3)'],
    ['B7', '=SUM(数量合计区)'],
  ] as const)
    await typeAddress(page, address, formula)
  await sheetTab(page, '汇总').click()
  await typeAddress(page, 'A1', '=SUM(\'数据\'!B2:B3)')
  await typeAddress(page, 'A2', '=\'数据\'!A2')
  expect(formulaFacts(await committedWorkbook(page, id))).toEqual(expectedFacts('数据', 2, 4, '青'))
  await sheetTab(page, '数据').click()

  await historyStep(page, id, '修改数值依赖后四个聚合与名称结果同步', formulaFacts, async () => typeAddress(page, 'B3', '9'), expectedFacts('数据', 2, 9, '青'))
  await historyStep(page, id, '修改文本依赖后本表拼接与另一表同步', formulaFacts, async () => typeAddress(page, 'A2', '海'), expectedFacts('数据', 2, 9, '海'))
  await historyStep(page, id, '插入第二行使全部相对及名称绝对引用同步平移', formulaFacts, async () => {
    await selectAddress(page, 'B2')
    const book = (await savedContent(page, id)).snapshot
    const rect = cellBounds(book, 'B2')
    await sheetCanvas(page).click({ button: 'right', position: { x: dimensions(book).rowHeader.width / 2, y: (rect.startY + rect.endY) / 2 } })
    await page.getByRole('button', { name: /^在上方插入/ }).click()
  }, expectedFacts('数据', 3, 9, '海'))
  await historyStep(page, id, '工作表重命名同步跨表与定义名称引用', formulaFacts, async () => renameSheet(page, '数据', '源数据'), expectedFacts('源数据', 3, 9, '海'))

  const final = await committedWorkbook(page, id)
  expect([cellOf(final, 'A3')?.v, cellOf(final, 'A4')?.v, cellOf(final, 'B3')?.v, cellOf(final, 'B4')?.v]).toEqual(['海', '山', 3, 9])
  await finishCapabilitySheet(page, actors)
  // 查看者在真实绘制结果上查找，不使用测试探针读取缓存。
  await sheetTab(page, '源数据').click()
  await expectFoundOnce(page, '海-3')
  await sheetTab(page, '汇总').click()
  await expectFoundOnce(page, '12')
  await expectFoundOnce(page, '海')
})
