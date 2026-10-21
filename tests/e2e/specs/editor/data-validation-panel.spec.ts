// US-M5-04：详情面板的本地显示必须与实际规则一致，快速跨设置操作不能互相覆盖（UR-033）。
// 每次操作都走正式 UI；保存后的断言使用服务器正文，公开流程也在生产构建中运行。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import sharp from 'sharp'
import { createDocument, createUser } from '../../support/database.ts'
import { nameBox, probeSnapshot } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, openAndEnterEditing, resourceOf, ribbon, saveAndWait, savedContent, selectCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const FIRST_SHEET = 'sheet-1'
const C3 = { startRow: 2, endRow: 2, startColumn: 2, endColumn: 2 }

function detail(page: Page) {
  return page.locator('[data-u-comp="data-validation-detail"]')
}

async function selectRangeText(page: Page): Promise<void> {
  const canvas = detail(page).locator('canvas').filter({ visible: true }).first()
  // 详情 DOM 先于内部文档绘制出现；确认范围文字已画出，避免点击尚未就绪的画布只触发 React 的 mouseup 聚焦。
  await expect.poll(async () => {
    const { data, info } = await sharp(await canvas.screenshot({ scale: 'css' })).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let ink = 0
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (data[offset + 3]! > 128 && Math.min(data[offset]!, data[offset + 1]!, data[offset + 2]!) < 180)
        ink += 1
    }
    return ink
  }, { message: '范围文字须已绘制，再进行真实文本选择' }).toBeGreaterThan(5)
  // 范围从画布左端绘制；双击实际文字建立文档选区，再全选。仅取得隐藏输入框的 DOM 焦点还不代表选区就绪。
  await canvas.dblclick({ position: { x: 12, y: 8 } })
  // 等内部文档取得焦点，再核对全选没有误作用到主表。
  await expect(page.locator('[data-u-comp="editor"][id^="__editor___INTERNAL_EDITOR__RICH_TEXT_EDITOR-"]')).toBeFocused()
  await pressUniverShortcut(page, 'A')
  await expect(nameBox(page)).toHaveValue('C3')
}

async function openRule(page: Page): Promise<void> {
  await selectCell(page, 'C3')
  await (await ribbon(page, '数据')).getByRole('button', { name: '数据验证' }).click()
  await page.getByRole('menuitem', { name: '新建规则' }).click()
  await expect(detail(page)).toBeVisible()
}

async function editRule(page: Page, range = 'C3'): Promise<void> {
  await (await ribbon(page, '数据')).getByRole('button', { name: '数据验证' }).click()
  await page.getByRole('menuitem', { name: '管理数据验证', exact: true }).click()
  await page.getByRole('complementary', { name: '侧边栏' }).getByText(range, { exact: true }).click()
  await expect(detail(page)).toBeVisible()
}

function listSample(unitId: string): string {
  const snapshot = JSON.parse(sheetSnapshotFor(unitId)) as Workbook
  const resource = snapshot.resources.find(item => item.name === 'SHEET_DATA_VALIDATION_PLUGIN')!
  resource.data = JSON.stringify({ [FIRST_SHEET]: [{ uid: 'list-rule', type: 'list', formula1: 'a,b,c', allowBlank: true, ranges: [C3] }] })
  return JSON.stringify(snapshot)
}

for (const { order, actions } of [
  { order: '设置后选项', actions: ['忽略空值', '拒绝输入'] },
  { order: '选项后设置', actions: ['拒绝输入', '忽略空值'] },
]) {
  test(`US-M5-04 数据验证${order}：一秒内的两次操作都保存，退出并重开仍保留`, async ({ page }, testInfo) => {
    await loginThroughApi(page, await createUser('dv-panel-order'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId, 'steady')
    await openRule(page)
    await detail(page).getByText('高级设置', { exact: true }).click()

    const before = await page.evaluate(() => performance.now())
    for (const label of actions)
      await detail(page).getByText(label, { exact: true }).click()
    const elapsed = await page.evaluate(() => performance.now()) - before
    await testInfo.attach('连续操作时间', { body: JSON.stringify({ elapsed, limit: 1000 }), contentType: 'application/json' })
    expect(elapsed, '两个真实 UI 操作必须处于同一个 1 秒防抖窗口').toBeLessThan(1000)
    await detail(page).getByRole('button', { name: '确认', exact: true }).click()
    await saveAndWait(page)
    const expected = {
      [FIRST_SHEET]: [{ type: 'decimal', operator: 'equal', formula1: '100', allowBlank: false, errorStyle: 1, ranges: [C3] }],
    }
    expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject(expected)
    await exitEditing(page, 'steady')
    await enterEditing(page, 'steady')
    await saveAndWait(page)
    expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject(expected)
  })
}

test('US-M5-04 范围之后立即改设置：快速逐字输入完整，两项都保留到服务器', async ({ page }, testInfo) => {
  await loginThroughApi(page, await createUser('dv-panel-range'))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId, 'steady')
  await openRule(page)
  await selectRangeText(page)
  const before = await page.evaluate(() => performance.now())
  // 范围画在 SDK 文档画布上；这里的原生 textbox 属于下面的公式输入，不能用它代替范围。
  await page.keyboard.type('C3:C4')
  await detail(page).getByText('忽略空值', { exact: true }).click()
  const elapsed = await page.evaluate(() => performance.now()) - before
  await testInfo.attach('连续操作时间', { body: JSON.stringify({ elapsed, limit: 1000 }), contentType: 'application/json' })
  expect(elapsed).toBeLessThan(1000)
  await detail(page).getByRole('button', { name: '确认', exact: true }).click()
  await saveAndWait(page)
  expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({
    [FIRST_SHEET]: [{ allowBlank: false, ranges: [{ ...C3, endRow: 3 }] }],
  })
})

test('US-M5-04 无效范围保持原规则，改正后确认与重开正常', async ({ page }) => {
  await loginThroughApi(page, await createUser('dv-panel-invalid'))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId, 'steady')
  await openRule(page)
  await selectRangeText(page)
  await page.keyboard.insertText('C0')
  await detail(page).getByRole('button', { name: '确认', exact: true }).click()
  await expect(detail(page)).toBeVisible()
  await saveAndWait(page)
  expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({ [FIRST_SHEET]: [{ ranges: [C3] }] })
  await selectRangeText(page)
  await page.keyboard.type('C3:C4')
  await detail(page).getByRole('button', { name: '确认', exact: true }).click()
  await exitEditing(page, 'steady')
  await enterEditing(page, 'steady')
  await saveAndWait(page)
  expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({ [FIRST_SHEET]: [{ ranges: [{ ...C3, endRow: 3 }] }] })
})

test('US-M5-04 直接关闭侧边栏同步提交输入', { tag: '@test-build' }, async ({ page }) => {
  await loginThroughApi(page, await createUser('dv-panel-unmount'))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId, 'steady')
  await openRule(page)
  const before = await page.evaluate(() => performance.now())
  await detail(page).getByText('忽略空值', { exact: true }).click()
  await page.getByRole('button', { name: '关闭侧边栏' }).click()
  await expect(detail(page)).toBeHidden()
  const snapshot = JSON.parse(await probeSnapshot(page)) as Workbook
  expect(await page.evaluate(() => performance.now()) - before).toBeLessThan(1000)
  expect(resourceOf(snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({ [FIRST_SHEET]: [{ allowBlank: false }] })
})

test('US-M5-04 删除后撤销恢复最新输入，重做删除和再次撤销均可保存', async ({ page }) => {
  await loginThroughApi(page, await createUser('dv-panel-delete'))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId, 'steady')
  await openRule(page)
  await detail(page).getByText('忽略空值', { exact: true }).click()
  await detail(page).getByRole('button', { name: '删除规则', exact: true }).click()
  await expect(detail(page)).toBeHidden()
  await selectCell(page, 'D4')
  await pressUniverShortcut(page, 'Z')
  await saveAndWait(page)
  const expected = { [FIRST_SHEET]: [{ allowBlank: false, ranges: [C3] }] }
  expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject(expected)
  await selectCell(page, 'D4')
  await pressUniverShortcut(page, 'Y')
  await saveAndWait(page)
  expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toEqual({ [FIRST_SHEET]: [] })
  await selectCell(page, 'D4')
  await pressUniverShortcut(page, 'Z')
  await exitEditing(page, 'steady')
  await enterEditing(page, 'steady')
  await saveAndWait(page)
  expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject(expected)
})

test('US-M5-04 下拉列表改设置后立即切到多选：不从旧模型覆盖已输入的设置', async ({ page }, testInfo) => {
  const author = await createUser('dv-panel-type')
  const documentId = await createDocument(author, '列表类型切换', listSample)
  await loginThroughApi(page, author)
  await openAndEnterEditing(page, documentId, 'steady')
  await editRule(page)
  const before = await page.evaluate(() => performance.now())
  await detail(page).getByText('忽略空值', { exact: true }).click()
  await detail(page).locator('[data-u-comp="select"]').first().click()
  await page.getByRole('menuitemradio', { name: '下拉菜单-多选', exact: true }).click()
  const elapsed = await page.evaluate(() => performance.now()) - before
  await testInfo.attach('连续操作时间', { body: JSON.stringify({ elapsed, limit: 1000 }), contentType: 'application/json' })
  expect(elapsed).toBeLessThan(1000)
  await detail(page).getByRole('button', { name: '确认', exact: true }).click()
  await saveAndWait(page)
  expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({
    [FIRST_SHEET]: [{ type: 'listMultiple', allowBlank: false }],
  })
})

test('US-M5-04 确认关闭详情时立即提交待办，不能等卸载后的计时器再写规则', { tag: '@test-build' }, async ({ page }) => {
  await loginThroughApi(page, await createUser('dv-panel-close'))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId, 'steady')
  await openRule(page)
  const before = await page.evaluate(() => performance.now())
  await detail(page).getByText('忽略空值', { exact: true }).click()
  await detail(page).getByRole('button', { name: '确认', exact: true }).click()
  await expect(detail(page)).toBeHidden()
  const snapshot = JSON.parse(await probeSnapshot(page)) as Workbook
  expect(await page.evaluate(() => performance.now()) - before).toBeLessThan(1000)
  expect(resourceOf(snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({ [FIRST_SHEET]: [{ allowBlank: false }] })
})

for (const { label, shortcuts, range, endRow } of [
  { label: '撤销', shortcuts: [{ key: 'Z', endRow: 2 }], range: 'C3', endRow: 2 },
  { label: '撤销再重做', shortcuts: [{ key: 'Z', endRow: 2 }, { key: 'Y', endRow: 3 }], range: 'C3:C4', endRow: 3 },
]) {
  test(`US-M5-04 范围${label}后确认：输入正文不能覆盖历史，保存重开仍一致`, async ({ page }) => {
    await loginThroughApi(page, await createUser('dv-panel-range-history'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId, 'steady')
    await openRule(page)
    await selectRangeText(page)
    await page.keyboard.type('C3:C4')
    await selectCell(page, 'A1')
    await saveAndWait(page)
    expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({ [FIRST_SHEET]: [{ ranges: [{ ...C3, endRow: 3 }] }] })
    for (const shortcut of shortcuts) {
      await selectCell(page, 'A1')
      await pressUniverShortcut(page, shortcut.key)
      await saveAndWait(page)
      expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({ [FIRST_SHEET]: [{ ranges: [{ ...C3, endRow: shortcut.endRow }] }] })
    }
    // 不重新输入范围；确认会读取实际编辑器正文，旧文字会使服务器断言失败。
    await detail(page).getByRole('button', { name: '确认', exact: true }).click()
    await expect(detail(page)).toBeHidden()
    await saveAndWait(page)
    const expected = { [FIRST_SHEET]: [{ ranges: [{ ...C3, endRow }] }] }
    expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject(expected)
    await exitEditing(page, 'steady')
    await enterEditing(page, 'steady')
    await editRule(page, range)
    await detail(page).getByRole('button', { name: '确认', exact: true }).click()
    await saveAndWait(page)
    expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject(expected)
  })
}

test('US-M5-04 自定义公式移动范围后改设置：保留平移、历史及重开后公式编辑器正文', async ({ page }, testInfo) => {
  const author = await createUser('dv-panel-formula-range')
  const documentId = await createDocument(author, '公式范围与设置', (unitId) => {
    const snapshot = JSON.parse(listSample(unitId)) as Workbook
    snapshot.resources.find(item => item.name === 'SHEET_DATA_VALIDATION_PLUGIN')!.data = JSON.stringify({
      [FIRST_SHEET]: [{ uid: 'custom-rule', type: 'custom', formula1: '=C3>5', allowBlank: true, ranges: [C3] }],
    })
    return JSON.stringify(snapshot)
  })
  await loginThroughApi(page, author)
  await openAndEnterEditing(page, documentId, 'steady')
  await selectCell(page, 'C3')
  await editRule(page)
  await selectRangeText(page)
  const before = await page.evaluate(() => performance.now())
  await page.keyboard.type('D4')
  await detail(page).getByText('忽略空值', { exact: true }).click()
  const elapsed = await page.evaluate(() => performance.now()) - before
  await testInfo.attach('范围与设置连续操作时间', { body: JSON.stringify({ elapsed, limit: 1000 }), contentType: 'application/json' })
  expect(elapsed).toBeLessThan(1000)
  await detail(page).getByRole('button', { name: '确认', exact: true }).click()
  const D4 = { startRow: 3, endRow: 3, startColumn: 3, endColumn: 3 }
  const savedRule = async (formula1: string, ranges: typeof C3[], allowBlank: boolean) => {
    await saveAndWait(page)
    expect(resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({ [FIRST_SHEET]: [{ formula1, ranges, allowBlank }] })
  }
  await savedRule('=D4>5', [D4], false)
  await selectCell(page, 'A1')
  await pressUniverShortcut(page, 'Z')
  await savedRule('=D4>5', [D4], true)
  await selectCell(page, 'A1')
  await pressUniverShortcut(page, 'Z')
  await savedRule('=C3>5', [C3], true)
  await selectCell(page, 'A1')
  await pressUniverShortcut(page, 'Y')
  await savedRule('=D4>5', [D4], true)
  await selectCell(page, 'A1')
  await pressUniverShortcut(page, 'Y')
  await savedRule('=D4>5', [D4], false)
  await exitEditing(page, 'steady')
  await enterEditing(page, 'steady')
  await editRule(page, 'D4')
  await detail(page).locator('canvas').filter({ visible: true }).nth(1).click({ position: { x: 12, y: 8 } })
  await expect(page.locator('[data-u-comp="editor"][id^="__editor___INTERNAL_EDITOR__embedding_formula_editor-"]')).toBeFocused()
  // 只改最后一个阈值，前面的 D4 必须来自实际编辑器正文，不能用整段覆盖掩盖旧显示。
  await pressUniverShortcut(page, 'A')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('7')
  await detail(page).getByRole('button', { name: '确认', exact: true }).click()
  await savedRule('=D4>7', [D4], false)
})
