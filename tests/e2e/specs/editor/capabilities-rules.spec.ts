// US-M5-04：数据验证的实际入口、规则、拒绝输入、历史、重开与查看者。
import type { Locator, Page, TestInfo } from '@playwright/test'
import type { ListFocusSnapshot } from '../../support/list-focus-observation.ts'
import type { Workbook } from '../../support/sheet.ts'
import { Buffer } from 'node:buffer'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { beginListAutoFocusObservation } from '../../support/list-focus-observation.ts'
import { committedWorkbook, finishCapabilitySheet, historyStep, openCapabilitySheet, selectAddress } from '../../support/sheet-capabilities.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, resourceOf, ribbon, selectCell, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const C3 = { startRow: 2, endRow: 2, startColumn: 2, endColumn: 2 }

interface ValidationRule {
  type: string
  formula1?: string
  formula2?: string
  operator?: string
  ranges: typeof C3[]
  allowBlank?: boolean
  errorStyle?: number
}

function dvRules(book: Workbook): ValidationRule[] {
  const rules = (resourceOf(book, 'SHEET_DATA_VALIDATION_PLUGIN') as Record<string, ValidationRule[]>)['sheet-1'] ?? []
  return rules.map(rule => ({
    ...rule,
    ranges: rule.ranges.map(({ startRow, endRow, startColumn, endColumn }) => ({ startRow, endRow, startColumn, endColumn })),
  }))
}

function dvDetail(page: Page): Locator {
  return page.locator('[data-u-comp="data-validation-detail"]')
}

async function openDv(page: Page, mode: 'new' | 'edit'): Promise<void> {
  await selectAddress(page, 'C3')
  await (await ribbon(page, '数据')).getByRole('button', { name: '数据验证', exact: true }).click()
  await page.getByRole('menuitem', { name: mode === 'new' ? '新建规则' : '管理数据验证', exact: true }).click()
  if (mode === 'edit')
    await page.getByRole('complementary', { name: '侧边栏' }).getByText('C3', { exact: true }).click()
  await expect(dvDetail(page)).toBeVisible()
}

async function confirmDv(page: Page): Promise<void> {
  await dvDetail(page).getByRole('button', { name: '确认', exact: true }).click()
  await expect(dvDetail(page)).toBeHidden()
  await page.getByRole('button', { name: '关闭侧边栏' }).click()
}

async function selectDvType(page: Page, label: string): Promise<void> {
  await dvDetail(page).locator('[data-u-comp="select"]').first().click()
  await page.getByRole('menuitemradio', { name: label, exact: true }).click()
}

async function selectDvOperator(page: Page, label: string): Promise<void> {
  await dvDetail(page).locator('[data-u-comp="select"]').nth(1).click()
  await page.getByRole('menuitemradio', { name: label, exact: true }).click()
}

async function customFormula(page: Page, text: string): Promise<void> {
  // 范围和公式都是画布，第二个可见画布属于自定义公式；点击绘出的文字再全选。
  await dvDetail(page).locator('canvas').filter({ visible: true }).nth(1).click({ position: { x: 12, y: 8 } })
  await expect(page.locator('[data-u-comp="editor"][id^="__editor___INTERNAL_EDITOR__embedding_formula_editor-"]')).toBeFocused()
  await pressUniverShortcut(page, 'A')
  await page.keyboard.type(text)
}

interface DvCase {
  name: string
  type: string
  setup: (page: Page) => Promise<void>
  modify: (page: Page) => Promise<void>
  initial: Partial<ValidationRule>
  changed: Partial<ValidationRule>
  valid: string
  value: string | number
  invalid: string[]
  error: RegExp
}

async function inputValidated(page: Page, value: string, beforeType?: () => Promise<void>): Promise<void> {
  // 点击复选框会切值、点击列表会展开；用名称框定位后真实键入，避免把准备动作混进输入历史。
  await selectAddress(page, 'C3')
  if (beforeType)
    await beforeType()
  await page.keyboard.type(value)
  await page.keyboard.press('Enter')
}

interface ListFocusWindow {
  value: string
  installAttempted: boolean
  handleCreated: boolean
  snapshot?: ListFocusSnapshot
  observationFailed: boolean
}

async function rejectInvalidInput(page: Page, invalid: string, example: DvCase, testInfo: TestInfo, listFocusWindows: ListFocusWindow[]): Promise<Locator> {
  const window: ListFocusWindow | undefined = example.type === 'list'
    ? { value: invalid, installAttempted: false, handleCreated: false, observationFailed: false }
    : undefined
  if (window)
    listFocusWindows.push(window)
  let observation: Awaited<ReturnType<typeof beginListAutoFocusObservation>> | undefined
  const errors: unknown[] = []
  const reject = page.getByRole('dialog', { name: '提示', exact: true })
  try {
    await inputValidated(page, invalid, window
      ? async () => {
        window.installAttempted = true
        observation = await beginListAutoFocusObservation(page)
        window.handleCreated = true
      }
      : undefined)
    await expect(reject).toBeVisible()
    await expect(reject).toContainText(example.error)
  }
  catch (error) {
    errors.push(error)
  }
  finally {
    if (window) {
      try {
        if (observation)
          window.snapshot = await observation.finish()
        else
          window.observationFailed = true
      }
      catch (error) {
        window.observationFailed = true
        errors.push(error)
      }
      try {
        const body = Buffer.from(JSON.stringify(window))
        if (body.byteLength > 4096) {
          errors.push(new Error('list-focus-attachment-too-large'))
          await testInfo.attach(`list-focus-${invalid}.json`, { body: '{"observationFailed":true,"reason":"attachment-too-large"}', contentType: 'application/json' })
        }
        else {
          await testInfo.attach(`list-focus-${invalid}.json`, { body, contentType: 'application/json' })
        }
      }
      catch (error) {
        errors.push(error)
      }
    }
  }
  // 原提示错误与观察/附件错误都保留；单个原错误保持原身份和栈。
  if (errors.length > 1)
    throw new AggregateError(errors, '非法输入验证与列表焦点观察存在多个失败')
  if (errors.length === 1)
    throw errors[0]
  return reject
}

function assertListFocusWindows(example: DvCase, listFocusWindows: ListFocusWindow[]): void {
  if (example.type === 'list') {
    expect(listFocusWindows.map(window => window.value)).toEqual(example.invalid)
    for (const window of listFocusWindows) {
      expect(window).toMatchObject({ installAttempted: true, handleCreated: true, observationFailed: false })
      expect(window.snapshot).toMatchObject({ started: true, sealed: true, events: [], overflow: false, expired: false })
      expect(Buffer.byteLength(JSON.stringify(window.snapshot))).toBeLessThanOrEqual(4096)
    }
  }
}

async function exerciseChoiceWidget(page: Page, id: string, example: DvCase): Promise<void> {
  const value = (book: Workbook) => cellOf(book, 'C3')?.v
  if (example.type === 'checkbox') {
    await historyStep(page, id, '实际点击复选框取消勾选', value, async () => selectCell(page, 'C3'), 'no')
    await historyStep(page, id, '实际点击复选框重新勾选', value, async () => selectCell(page, 'C3'), 'done')
  }
  if (example.type === 'list') {
    for (const option of ['blue', 'green']) {
      await historyStep(page, id, `实际从列表选择${option}`, value, async () => {
        await selectCell(page, 'C3')
        const item = page.getByText(option, { exact: true }).filter({ visible: true })
        await expect(item).toBeVisible()
        await item.click()
      }, option)
    }
  }
}

const dvCases: DvCase[] = [
  {
    name: '下拉菜单',
    type: 'list',
    setup: async (page) => {
      await dvDetail(page).getByText('添加选项', { exact: true }).click()
      await dvDetail(page).getByRole('textbox').first().fill('red')
      await dvDetail(page).getByText('添加选项', { exact: true }).click()
      await dvDetail(page).getByRole('textbox').nth(1).fill('blue')
    },
    modify: async page => dvDetail(page).getByRole('textbox').first().fill('green'),
    initial: { type: 'list', formula1: '["red","blue"]' },
    changed: { type: 'list', formula1: '["green","blue"]' },
    valid: 'green',
    value: 'green',
    invalid: ['red', 'cyan'],
    error: /输入必须在指定的范围内/,
  },
  {
    name: '复选框',
    type: 'checkbox',
    setup: async (page) => {
      await dvDetail(page).getByText('在单元格内使用自定义值', { exact: true }).click()
      await dvDetail(page).getByPlaceholder('请输入值', { exact: true }).nth(0).fill('yes')
      await dvDetail(page).getByPlaceholder('请输入值', { exact: true }).nth(1).fill('no')
    },
    modify: async page => dvDetail(page).getByPlaceholder('请输入值', { exact: true }).first().fill('done'),
    initial: { type: 'checkbox', formula1: 'yes', formula2: 'no' },
    changed: { type: 'checkbox', formula1: 'done', formula2: 'no' },
    valid: 'done',
    value: 'done',
    invalid: ['yes', 'other'],
    error: /此单元格的内容违反了验证规则/,
  },
  {
    name: '整数',
    type: 'whole',
    setup: async (page) => {
      await selectDvOperator(page, '大于')
      await dvDetail(page).getByPlaceholder('请输入值或公式', { exact: true }).fill('0')
    },
    modify: async page => dvDetail(page).getByPlaceholder('请输入值或公式', { exact: true }).fill('2'),
    initial: { type: 'whole', operator: 'greaterThan', formula1: '0' },
    changed: { type: 'whole', operator: 'greaterThan', formula1: '2' },
    valid: '3',
    value: 3,
    invalid: ['1', '3.5'],
    error: /值必须大于 2/,
  },
  {
    name: '日期',
    type: 'date',
    setup: async (page) => {
      await selectDvOperator(page, '晚于')
      await dvDetail(page).getByPlaceholder('请输入值或公式', { exact: true }).fill('2025-01-01')
    },
    modify: async page => dvDetail(page).getByPlaceholder('请输入值或公式', { exact: true }).fill('2025-02-01'),
    initial: { type: 'date', operator: 'greaterThan', formula1: '2025-01-01' },
    changed: { type: 'date', operator: 'greaterThan', formula1: '2025-02-01' },
    valid: '2025-03-01',
    value: (Date.UTC(2025, 2, 1) - Date.UTC(1899, 11, 30)) / 86_400_000,
    invalid: ['2025-01-20', 'not-a-date'],
    error: /必须为有效日期且晚于/,
  },
  {
    name: '自定义公式',
    type: 'custom',
    setup: async page => customFormula(page, '=C3>2'),
    modify: async page => customFormula(page, '=C3>5'),
    initial: { type: 'custom', formula1: '=C3>2' },
    changed: { type: 'custom', formula1: '=C3>5' },
    valid: '7',
    value: 7,
    invalid: ['4', '2'],
    error: /此单元格的内容违反了验证规则/,
  },
]

for (const example of dvCases) {
  test(`US-M5-04 ${example.name}通过正式面板创建修改删除，合法输入保留、非法输入拒绝且历史可恢复`, async ({ page }, testInfo) => {
    const listFocusWindows: ListFocusWindow[] = []
    const actors = await openCapabilitySheet(page, `dv-${example.type}`)
    const id = actors.documentId
    await typeInCell(page, 'A1', 'validation-marker')
    await historyStep(page, id, '新建规则与撤销重做', book => dvRules(book).map(({ type, formula1, operator, ranges }) => ({ type, formula1, operator, ranges })), async () => {
      await openDv(page, 'new')
      await confirmDv(page)
    }, [{ type: 'decimal', formula1: '100', operator: 'equal', ranges: [C3] }])

    await openDv(page, 'edit')
    await selectDvType(page, example.name)
    await example.setup(page)
    await dvDetail(page).getByText('高级设置', { exact: true }).click()
    await dvDetail(page).getByText('拒绝输入', { exact: true }).click()
    await confirmDv(page)
    expect(dvRules(await committedWorkbook(page, id))).toMatchObject([{ ...example.initial, errorStyle: 1, ranges: [C3] }])

    await historyStep(page, id, '修改本类型的实际条件', book => dvRules(book)[0]?.formula1, async () => {
      await openDv(page, 'edit')
      await example.modify(page)
      await confirmDv(page)
    }, example.changed.formula1)
    expect(dvRules(await committedWorkbook(page, id))).toMatchObject([{ ...example.changed, errorStyle: 1, ranges: [C3] }])

    await historyStep(page, id, '接受合法值', book => cellOf(book, 'C3')?.v ?? null, async () => inputValidated(page, example.valid), example.value)
    for (const invalid of example.invalid) {
      const reject = await rejectInvalidInput(page, invalid, example, testInfo, listFocusWindows)
      await reject.getByRole('button', { name: '确定', exact: true }).click()
      await page.keyboard.press('Escape')
      await selectAddress(page, 'A1')
      expect(cellOf(await committedWorkbook(page, id), 'C3')?.v).toBe(example.value)
    }
    await exerciseChoiceWidget(page, id, example)

    await historyStep(page, id, '删除本类型规则并恢复', book => dvRules(book).map(({ type, formula1, formula2, operator, ranges, errorStyle }) => ({ type, formula1, formula2, operator, ranges, errorStyle })), async () => {
      await openDv(page, 'edit')
      await dvDetail(page).getByRole('button', { name: '删除规则', exact: true }).click()
      await page.getByRole('button', { name: '关闭侧边栏' }).click()
    }, [])
    await selectAddress(page, 'A1')
    await pressUniverShortcut(page, 'Z')
    expect(dvRules(await committedWorkbook(page, id))).toMatchObject([{ ...example.changed, errorStyle: 1, ranges: [C3] }])
    expect(cellOf(await committedWorkbook(page, id), 'C3')?.v).toBe(example.value)
    await finishCapabilitySheet(page, actors, 'validation-marker')
    assertListFocusWindows(example, listFocusWindows)
  })
}
