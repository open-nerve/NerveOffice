// 常用的表格功能照常可用（P4 设计 §3.6.9，ADR-009，审查 B2）：编辑器的身份换成平台"全部允许"的授权服务、SDK 的当前用户保持匿名之后，
// SDK 的权限检查照常放行：界面入口可用，命令照常执行，结果随保存写到服务器上。每项都经界面操作，按接口取回的快照核对。
// 另有变更检测的两类（P4 设计 §3.6.5）：只改视图不算修改，改格式算修改。
import type { Page } from '@playwright/test'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { appendSheet, cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openEditor, reloadAndEnterEditing, resourceOf, ribbon, saveAndWait, savedContent, saveStatus, selectCell, selectRange, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const FIRST_SHEET = 'sheet-1'

/** A1:A3 这样一列三格的区域（快照里的写法） */
const A1_TO_A3 = { startRow: 0, startColumn: 0, endRow: 2, endColumn: 0 }

async function openNewSheet(page: Page, prefix: string): Promise<string> {
  await loginThroughApi(page, await createUser(prefix))
  const documentId = await createSheetThroughApi(page)
  await openEditor(page, documentId, 'steady')
  return documentId
}

/** 在第一张表的 A1:A3 键入 3、1、2 */
async function typeNumbers(page: Page): Promise<void> {
  await typeInCell(page, 'A1', '3')
  await typeInCell(page, 'A2', '1')
  await typeInCell(page, 'A3', '2')
}

function sidebar(page: Page) {
  return page.getByRole('complementary', { name: '侧边栏' })
}

test.describe('US-M1-05 常用的表格功能照常可用并保存（身份替换之后，ADR-009）', () => {
  test('增删工作表', async ({ page }) => {
    const documentId = await openNewSheet(page, 'features-sheets')
    await appendSheet(page)
    await expect(page.getByRole('tab', { name: '工作表2' })).toHaveAttribute('aria-selected', 'true')
    await saveAndWait(page)
    expect((await savedContent(page, documentId)).snapshot.sheetOrder).toHaveLength(2)

    await page.getByRole('tab', { name: '工作表2' }).click({ button: 'right' })
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('dialog', { name: '删除工作表' }).getByRole('button', { name: '确定' }).click()
    await expect(page.getByRole('tab', { name: '工作表2' })).toHaveCount(0)
    await saveAndWait(page)
    expect((await savedContent(page, documentId)).snapshot.sheetOrder).toEqual([FIRST_SHEET])
  })

  test('排序与筛选', async ({ page }) => {
    const documentId = await openNewSheet(page, 'features-sort-filter')
    await typeNumbers(page)
    await selectRange(page, 'A1', 'A3')
    const data = await ribbon(page, '数据')
    await data.getByRole('button', { name: '排序' }).click()
    await page.getByRole('menuitem', { name: '当前区域升序' }).click()
    // 筛选的按钮没有可访问的名称（SDK 的界面如此），按它的命令标记定位
    await data.locator('[data-u-command="sheet.command.smart-toggle-filter"]').filter({ visible: true }).click()
    await saveAndWait(page)

    const { snapshot } = await savedContent(page, documentId)
    expect(['A1', 'A2', 'A3'].map(a1 => cellOf(snapshot, a1)?.v)).toEqual([1, 2, 3])
    expect(resourceOf(snapshot, 'SHEET_FILTER_PLUGIN')).toMatchObject({ [FIRST_SHEET]: { ref: A1_TO_A3 } })
  })

  test('条件格式与数据验证', async ({ page }) => {
    const documentId = await openNewSheet(page, 'features-cf-dv')
    await typeNumbers(page)
    await selectRange(page, 'A1', 'A3')
    const data = await ribbon(page, '数据')
    await data.getByRole('button', { name: '条件格式' }).click()
    await page.getByRole('menuitem', { name: '突出显示单元格' }).click()
    // 默认的规则是"文本包含"：填上要包含的文字
    await sidebar(page).getByRole('textbox').fill('1')
    await sidebar(page).getByRole('button', { name: '确认' }).click()
    await sidebar(page).getByRole('button', { name: '关闭侧边栏' }).click()

    await selectCell(page, 'C3')
    await data.getByRole('button', { name: '数据验证' }).click()
    await page.getByRole('menuitem', { name: '新建规则' }).click()
    // 新建的规则是"数字等于 100"
    await sidebar(page).getByRole('button', { name: '确认' }).click()
    await saveAndWait(page)

    const { snapshot } = await savedContent(page, documentId)
    expect(resourceOf(snapshot, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN')).toMatchObject({
      [FIRST_SHEET]: [{ ranges: [A1_TO_A3], rule: { type: 'highlightCell', operator: 'containsText', value: '1' } }],
    })
    expect(resourceOf(snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({
      [FIRST_SHEET]: [{ type: 'decimal', operator: 'equal', formula1: '100', ranges: [{ startRow: 2, startColumn: 2, endRow: 2, endColumn: 2 }] }],
    })
  })

  test('批注与查找替换', async ({ page }) => {
    const documentId = await openNewSheet(page, 'features-note-replace')
    await typeInCell(page, 'B1', 'apple')
    await typeInCell(page, 'B2', 'apple pie')

    await selectCell(page, 'D4', { button: 'right' })
    await page.getByRole('button', { name: '添加批注' }).click()
    await page.getByRole('textbox', { name: '在此输入' }).click()
    await page.keyboard.type('check later')
    // 点别处，批注写入；查找时选中的是这一格（选中区域时只在区域里查找）
    await selectCell(page, 'F8')

    const data = await ribbon(page, '数据')
    await data.getByRole('button', { name: '查找替换' }).click()
    const find = page.getByRole('dialog', { name: '查找' })
    await find.getByText('替换 / 高级查找').click()
    await find.getByRole('textbox', { name: '输入查找内容' }).fill('apple')
    await find.getByRole('textbox', { name: '输入替换内容' }).fill('banana')
    await find.getByRole('button', { name: '查找', exact: true }).click()
    // 两处匹配（当前是第几处取决于选中的位置）
    await expect(find).toContainText(/[12]\/2/)
    await find.getByRole('button', { name: '替换全部' }).click()
    await page.getByRole('dialog', { name: '确定要替换所有的匹配项吗？' }).getByRole('button', { name: '确定' }).click()
    await find.getByRole('button', { name: 'Close' }).click()
    await saveAndWait(page)

    const { snapshot } = await savedContent(page, documentId)
    expect([cellOf(snapshot, 'B1')?.v, cellOf(snapshot, 'B2')?.v]).toEqual(['banana', 'banana pie'])
    expect(resourceOf(snapshot, 'SHEET_NOTE_PLUGIN')).toMatchObject({ [FIRST_SHEET]: { 3: { 3: { note: 'check later', row: 3, col: 3 } } } })
  })
})

test.describe('US-M1-05 只改视图不算修改，改格式算修改（P4 设计 §3.6.5）', () => {
  test('选中、滚动、缩放、切换工作表、查找：仍是已保存，离开不提示；加粗：有未保存的修改，保存后格式在服务器上', async ({ page }) => {
    const documentId = await openNewSheet(page, 'view-only')
    await typeInCell(page, 'A1', 'apple')
    await appendSheet(page)
    await saveAndWait(page)
    const { revision } = await savedContent(page, documentId)

    await page.getByRole('tab', { name: '工作表1' }).click()
    await selectRange(page, 'B2', 'D4')
    await selectCell(page, 'C3')
    const find = page.getByRole('dialog', { name: '查找' })
    await (await ribbon(page, '数据')).getByRole('button', { name: '查找替换' }).click()
    await find.getByRole('textbox', { name: '输入查找内容' }).fill('apple')
    await find.getByRole('textbox', { name: '输入查找内容' }).press('Enter')
    await expect(find).toContainText('1/1')
    await find.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: '放大' }).click()
    await expect(page.getByRole('textbox', { name: '缩放' })).not.toHaveValue('100%')
    await page.locator('canvas[id^="univer-sheet-main-canvas_"]').hover()
    await page.mouse.wheel(0, 600)
    await expect(saveStatus(page)).toHaveText('已保存到云端')

    // 离开时浏览器不提示：记下出现的对话框并接受（不接受的话页面不会离开）
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type())
      void dialog.accept()
    })
    await reloadAndEnterEditing(page, 'steady')
    expect(dialogs).toEqual([])
    expect((await savedContent(page, documentId)).revision).toBe(revision)

    await page.getByRole('tab', { name: '工作表1' }).click()
    await selectCell(page, 'A1')
    await (await ribbon(page, '开始')).getByRole('button', { name: '粗体' }).click()
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await saveAndWait(page)
    const { snapshot } = await savedContent(page, documentId)
    const style = cellOf(snapshot, 'A1')?.s
    expect(typeof style === 'string' ? snapshot.styles[style] : style).toMatchObject({ bl: 1 })
  })
})
