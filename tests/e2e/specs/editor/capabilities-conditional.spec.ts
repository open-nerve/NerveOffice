// US-M5-04：六类条件格式的真实面板、画布呈现、历史和服务器持久化。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import sharp from 'sharp'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { cellBounds, committedWorkbook, finishCapabilitySheet, historyStep, openCapabilitySheet, selectAddress } from '../../support/sheet-capabilities.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, resourceOf, ribbon, savedContent, sheetCanvas, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

interface CfRule {
  ranges: { startRow: number, endRow: number, startColumn: number, endColumn: number }[]
  rule: Record<string, unknown>
}

const range = { startRow: 1, endRow: 4, startColumn: 0, endColumn: 0 }

function sidebar(page: Page) {
  return page.getByRole('complementary', { name: '侧边栏' })
}

function cfRules(book: Workbook): CfRule[] {
  const rules = (resourceOf(book, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN') as Record<string, CfRule[]> | undefined)?.['sheet-1'] ?? []
  return rules.map(({ ranges, rule }) => ({
    ranges: ranges.map(({ startRow, endRow, startColumn, endColumn }) => ({ startRow, endRow, startColumn, endColumn })),
    rule,
  }))
}

async function openCf(page: Page, mode: 'new' | 'edit'): Promise<void> {
  await selectAddress(page, 'A2:A5')
  await (await ribbon(page, '数据')).getByRole('button', { name: '条件格式', exact: true }).click()
  await page.getByRole('menuitem', { name: mode === 'new' ? '突出显示单元格' : '管理条件格式', exact: true }).click()
  if (mode === 'edit')
    await sidebar(page).getByText('A2:A5', { exact: true }).click()
  await expect(sidebar(page).getByRole('button', { name: '确认', exact: true })).toBeVisible()
}

async function confirmCf(page: Page): Promise<void> {
  await sidebar(page).getByRole('button', { name: '确认', exact: true }).click()
  await expect(sidebar(page).getByText('A2:A5', { exact: true })).toBeVisible()
  await sidebar(page).getByRole('button', { name: '关闭侧边栏' }).click()
}

async function choose(page: Page, index: number, label: string): Promise<void> {
  const input = sidebar(page).locator('[data-u-comp="select"]').nth(index)
  await expect(input).toBeVisible()
  await input.click()
  const option = page.getByRole('menuitemradio', { name: label, exact: true })
  await expect(option).toBeVisible()
  await option.click()
}

async function formula(page: Page, value: string): Promise<void> {
  await sidebar(page).locator('canvas').filter({ visible: true }).nth(1).click({ position: { x: 12, y: 8 } })
  await expect(page.locator('[data-u-comp="editor"][id^="__editor___INTERNAL_EDITOR__embedding_formula_editor-"]')).toBeFocused()
  await pressUniverShortcut(page, 'A')
  await page.keyboard.type(value)
}

const highlightStyle = { bg: { rgb: '#e8ecfc' }, cl: { rgb: '#2f56ef' } }
const highlight = (subType: string, rest: Record<string, unknown> = {}) => ({ type: 'highlightCell', subType, style: highlightStyle, ...rest })
const dataBar = (isGradient: boolean) => ({ type: 'dataBar', isShowValue: true, config: { min: { type: 'min', value: 0 }, max: { type: 'max', value: 100 }, isGradient, positiveColor: '#ffbe38', nativeColor: '#abd91a' } })
function scale(withMiddle: boolean) {
  return {
    type: 'colorScale',
    config: [
      { index: 0, color: '#d0d9fb', value: { type: 'min', value: 10 } },
      ...withMiddle ? [{ index: 1, color: '#7790f3', value: { type: 'percent', value: 50 } }] : [],
      { index: withMiddle ? 2 : 1, color: '#2e55ef', value: { type: 'max', value: 90 } },
    ],
  }
}

interface CfCase {
  name: string
  key: string
  values: string[]
  setup: (page: Page) => Promise<void>
  modify: (page: Page) => Promise<void>
  initial: Record<string, unknown>
  changed: Record<string, unknown>
  initialMask: boolean[]
  changedMask: boolean[]
  editedCell: string
  editedMask: boolean[]
}

const cases: CfCase[] = [
  {
    name: '数值比较',
    key: 'number',
    values: ['1', '5', '9', '5'],
    setup: async (page) => {
      await choose(page, 1, '数值')
      await choose(page, 2, '大于')
      await sidebar(page).getByRole('textbox').fill('4')
    },
    modify: async page => sidebar(page).getByRole('textbox').fill('6'),
    initial: highlight('number', { operator: 'greaterThan', value: 4 }),
    changed: highlight('number', { operator: 'greaterThan', value: 6 }),
    initialMask: [false, true, true, true],
    changedMask: [false, false, true, false],
    editedCell: '8',
    editedMask: [true, false, true, false],
  },
  {
    name: '文本',
    key: 'text',
    values: ['oak', 'pine', 'oakland', 'birch'],
    setup: async page => sidebar(page).getByRole('textbox').fill('oak'),
    modify: async page => sidebar(page).getByRole('textbox').fill('pine'),
    initial: highlight('text', { operator: 'containsText', value: 'oak' }),
    changed: highlight('text', { operator: 'containsText', value: 'pine' }),
    initialMask: [true, false, true, false],
    changedMask: [false, true, false, false],
    editedCell: 'pine',
    editedMask: [true, true, false, false],
  },
  {
    name: '重复值',
    key: 'duplicate',
    values: ['1', '5', '9', '5'],
    setup: async page => choose(page, 1, '重复值'),
    modify: async page => choose(page, 1, '唯一值'),
    initial: highlight('duplicateValues'),
    changed: highlight('uniqueValues'),
    initialMask: [false, true, false, true],
    changedMask: [true, false, true, false],
    editedCell: '5',
    editedMask: [false, false, true, false],
  },
  {
    name: '公式',
    key: 'formula',
    values: ['1', '5', '9', '5'],
    setup: async (page) => {
      await choose(page, 0, '自定义公式')
      await formula(page, '=A2>4')
    },
    modify: async page => formula(page, '=A2>6'),
    initial: highlight('formula', { value: '=A2>4' }),
    changed: highlight('formula', { value: '=A2>6' }),
    initialMask: [false, true, true, true],
    changedMask: [false, false, true, false],
    editedCell: '8',
    editedMask: [true, false, true, false],
  },
  {
    name: '数据条',
    key: 'bar',
    values: ['1', '5', '9', '5'],
    setup: async page => choose(page, 0, '数据条'),
    modify: async page => sidebar(page).getByText('渐变', { exact: true }).click(),
    initial: dataBar(false),
    changed: dataBar(true),
    initialMask: [false, true, true, true],
    changedMask: [false, true, true, true],
    editedCell: '9',
    editedMask: [true, false, true, false],
  },
  {
    name: '色阶',
    key: 'scale',
    values: ['1', '5', '9', '5'],
    setup: async page => choose(page, 0, '色阶'),
    modify: async page => choose(page, 2, '百分比'),
    initial: scale(false),
    changed: scale(true),
    initialMask: [true, true, true, true],
    changedMask: [true, true, true, true],
    editedCell: '9',
    editedMask: [true, true, true, true],
  },
]

/** 从实际浏览器截图取色；沿用图片验收方式，WebKit 的 SDK 画布不允许 getImageData。采样避开文字、网格和选区。 */
async function canvasColors(page: Page, id: string): Promise<number[][]> {
  const book = (await savedContent(page, id)).snapshot
  const points = [2, 3, 4, 5].map((row) => {
    const rect = cellBounds(book, `A${row}`)
    return { x: rect.startX + 20, y: rect.startY + 5 }
  })
  const { data, info } = await sharp(await sheetCanvas(page).screenshot({ scale: 'css' })).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return points.map(({ x, y }) => {
    expect(x).toBeLessThan(info.width)
    expect(y).toBeLessThan(info.height)
    const offset = (Math.floor(y) * info.width + Math.floor(x)) * info.channels
    return [...data.subarray(offset, offset + 3)]
  })
}

async function expectPaint(page: Page, id: string, mask: boolean[]): Promise<void> {
  await selectAddress(page, 'D1')
  await expect.poll(async () => (await canvasColors(page, id)).map(([r, g, b]) => Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 10), '实际单元格底色/数据条应随条件变化').toEqual(mask)
}

for (const example of cases) {
  test(`US-M5-04 条件格式${example.name}创建修改删除有独立历史，实际呈现与重开后的资源和值一致`, async ({ page }) => {
    const actors = await openCapabilitySheet(page, `cf-${example.key}`)
    const id = actors.documentId
    await typeInCell(page, 'A1', 'conditional-marker')
    for (const [index, value] of example.values.entries())
      await typeInCell(page, `A${index + 2}`, value)
    const before = await committedWorkbook(page, id)
    const values = ['A2', 'A3', 'A4', 'A5'].map(address => cellOf(before, address)?.v)
    await expectPaint(page, id, [false, false, false, false])
    await historyStep(page, id, '新建条件格式', cfRules, async () => {
      await openCf(page, 'new')
      await example.setup(page)
      await confirmCf(page)
    }, [{ ranges: [range], rule: example.initial }])
    await expectPaint(page, id, example.initialMask)
    const firstColors = await canvasColors(page, id)
    await historyStep(page, id, '修改实际条件或样式', cfRules, async () => {
      await openCf(page, 'edit')
      await example.modify(page)
      await confirmCf(page)
    }, [{ ranges: [range], rule: example.changed }])
    await expectPaint(page, id, example.changedMask)
    const changedColors = await canvasColors(page, id)
    expect(changedColors, '改条件或渐变/色阶后画布必须有实际变化').not.toEqual(firstColors)
    await historyStep(page, id, '改变单元格输入触发条件重算', book => String(cellOf(book, 'A2')?.v), async () => typeInCell(page, 'A2', example.editedCell), example.editedCell)
    await expectPaint(page, id, example.editedMask)
    expect(await canvasColors(page, id), '改值后实际颜色或数据条必须更新').not.toEqual(changedColors)
    await selectAddress(page, 'D1')
    await pressUniverShortcut(page, 'Z')
    await committedWorkbook(page, id)
    await expectPaint(page, id, example.changedMask)
    await historyStep(page, id, '清除所选区域规则', cfRules, async () => {
      await selectAddress(page, 'A2:A5')
      await (await ribbon(page, '数据')).getByRole('button', { name: '条件格式', exact: true }).click()
      await page.getByRole('menuitem', { name: '清除所选区域的规则', exact: true }).click()
    }, [])
    await expectPaint(page, id, [false, false, false, false])
    await selectAddress(page, 'D1')
    await pressUniverShortcut(page, 'Z')
    const restored = await committedWorkbook(page, id)
    expect(cfRules(restored)).toEqual([{ ranges: [range], rule: example.changed }])
    expect(['A2', 'A3', 'A4', 'A5'].map(address => cellOf(restored, address)?.v)).toEqual(values)
    await finishCapabilitySheet(page, actors, 'conditional-marker')
    await expectPaint(page, id, example.changedMask)
  })
}

test('US-M5-04 条件格式拒绝空条件和不完整公式，修正后通过正式确认持久化', async ({ page }) => {
  const actors = await openCapabilitySheet(page, 'cf-invalid')
  const id = actors.documentId
  await typeInCell(page, 'A1', 'invalid-rule-marker')
  await typeInCell(page, 'A2', '9')
  await openCf(page, 'new')
  await sidebar(page).getByRole('button', { name: '确认', exact: true }).click()
  await expect(sidebar(page).getByText('条件不能为空', { exact: true })).toBeVisible()
  expect(cfRules(await committedWorkbook(page, id))).toEqual([])
  await choose(page, 0, '自定义公式')
  await formula(page, '=SUM(')
  await sidebar(page).getByRole('button', { name: '确认', exact: true }).click()
  await expect(sidebar(page).getByText('公式错误', { exact: true })).toBeVisible()
  expect(cfRules(await committedWorkbook(page, id))).toEqual([])
  await formula(page, '=A2>4')
  await confirmCf(page)
  expect(cfRules(await committedWorkbook(page, id))).toEqual([{ ranges: [range], rule: highlight('formula', { value: '=A2>4' }) }])
  await expectPaint(page, id, [true, false, false, false])
  await finishCapabilitySheet(page, actors, 'invalid-rule-marker')
  await expectPaint(page, id, [true, false, false, false])
})
