import type { Page } from '@playwright/test'
import type { FacadeApi } from '../../support/editor-probe.ts'
import type { Workbook } from '../../support/sheet.ts'
import { checkCellLinks } from '@nerve-office/contracts'
import { createUser } from '../../support/database.ts'
import { commandMark, editorView, nameBox, probeCommands, probeSnapshot, runFacade, waitForCommand } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { loginThroughApi } from '../../support/session.ts'
import { appendSheet, cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, hoverCell, openAndEnterEditing, openCellEditor, reloadAndEnterEditing, ribbon, saveAndWait, savedContent, selectCell, sheetTab, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const addressInput = (page: Page) => page.getByPlaceholder('输入链接地址', { exact: true })
const linkEdit = (page: Page) => page.locator('[data-u-comp="cell-link-popup-edit"]')
const linkRemove = (page: Page) => page.locator('[data-u-comp="cell-link-popup-remove"]')
const linkPreview = (page: Page) => page.locator('[data-u-comp="cell-link-popup-copy"]').locator('xpath=../..')
const linkDestination = (page: Page) => linkPreview(page).locator('span.univer-flex-1')

async function open(page: Page, prefix: string): Promise<string> {
  await loginThroughApi(page, await createUser(prefix))
  const id = await createSheetThroughApi(page)
  await openAndEnterEditing(page, id, 'steady')
  return id
}

async function away(page: Page): Promise<void> {
  await page.mouse.move(1, 1)
  await selectCell(page, 'J15')
  await expect(page.locator('[data-u-comp="cell-link-popup-copy"]')).toBeHidden()
}

async function addLink(page: Page, a1: string, label: string, href: string): Promise<void> {
  await away(page)
  await typeInCell(page, a1, label)
  // 回车已把选区下移；用方向键选回，避免快速点回同一坐标被 SDK 识别成双击。
  await page.keyboard.press('ArrowUp')
  await expect(nameBox(page)).toHaveValue(a1)
  await pressUniverShortcut(page, 'K')
  await expect(addressInput(page)).toBeVisible()
  await addressInput(page).fill(href)
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(addressInput(page)).toBeHidden()
}

function expectLink(snapshot: Workbook, a1: string, label: string, href: string): void {
  const cell = cellOf(snapshot, a1)
  expect(cell).toMatchObject({ p: { body: { dataStream: `${label}\r\n`, customRanges: [{ properties: { url: href } }] } } })
  expect(checkCellLinks(cell?.p)).toEqual({ ok: true })
}

async function undoOrRedo(page: Page, key: 'Z' | 'Y'): Promise<void> {
  await away(page)
  await selectCell(page, 'H10')
  await pressUniverShortcut(page, key)
}

test('US-M5-08 正式链接添加、修改、取消可撤销重做，保存重开与只读重建保持', async ({ page }) => {
  const id = await open(page, 'link-input')
  await addLink(page, 'B3', '查看资料', '/documents/../spaces?name=a b')
  await saveAndWait(page)
  expectLink((await savedContent(page, id)).snapshot, 'B3', '查看资料', '/spaces?name=a%20b')

  await hoverCell(page, 'B3')
  await expect(linkEdit(page)).toBeVisible()
  await linkEdit(page).click()
  await addressInput(page).fill('//example.invalid/private')
  await page.getByPlaceholder('输入文本', { exact: true }).fill('更新资料')
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByText('请输入合法的链接', { exact: true })).toBeVisible()
  await expect(addressInput(page)).toBeVisible()
  expectLink((await savedContent(page, id)).snapshot, 'B3', '查看资料', '/spaces?name=a%20b')
  await addressInput(page).fill('HTTPS://EXAMPLE.INVALID/a/../docs?name=a b')
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(addressInput(page)).toBeHidden()
  await saveAndWait(page)
  expectLink((await savedContent(page, id)).snapshot, 'B3', '更新资料', 'https://example.invalid/docs?name=a%20b')

  await undoOrRedo(page, 'Z')
  await saveAndWait(page)
  expectLink((await savedContent(page, id)).snapshot, 'B3', '查看资料', '/spaces?name=a%20b')
  await undoOrRedo(page, 'Y')
  await saveAndWait(page)
  expectLink((await savedContent(page, id)).snapshot, 'B3', '更新资料', 'https://example.invalid/docs?name=a%20b')

  await hoverCell(page, 'B3')
  await expect(linkRemove(page)).toBeVisible()
  await linkRemove(page).click()
  await saveAndWait(page)
  const unlinked = cellOf((await savedContent(page, id)).snapshot, 'B3')
  expect(unlinked?.p?.body?.dataStream?.trim() ?? unlinked?.v).toBe('更新资料')
  expect(unlinked?.p?.body?.customRanges ?? []).toEqual([])
  await undoOrRedo(page, 'Z')
  await saveAndWait(page)
  await exitEditing(page, 'steady')
  await hoverCell(page, 'B3')
  await expect(page.locator('[data-u-comp="cell-link-popup-copy"]')).toBeVisible()
  await expect(linkEdit(page)).toBeHidden()
  await expect(linkRemove(page)).toBeHidden()
  await away(page)
  await selectCell(page, 'B3')
  await pressUniverShortcut(page, 'K')
  await expect(addressInput(page)).toBeHidden()
  await enterEditing(page, 'steady')
  await addLink(page, 'D5', '联系邮件负责人', 'mailto:person@example.invalid?subject=a b')
  await saveAndWait(page)
  await reloadAndEnterEditing(page, 'steady')
  const reopened = (await savedContent(page, id)).snapshot
  expectLink(reopened, 'B3', '更新资料', 'https://example.invalid/docs?name=a%20b')
  expectLink(reopened, 'D5', '联系邮件负责人', 'mailto:person@example.invalid?subject=a%20b')
  await hoverCell(page, 'D5')
  await expect(linkEdit(page)).toBeVisible()
  await linkEdit(page).click()
  await expect(addressInput(page)).toHaveValue('mailto:person@example.invalid?subject=a%20b')
  await page.getByRole('button', { name: '取消', exact: true }).click()
})

test('US-M5-08 富文本选区通过真实表单添加和更新，非法命令不改正文或历史 @test-build', async ({ page }) => {
  const id = await open(page, 'link-rich')
  await typeInCell(page, 'B3', '富文本资料')
  await openCellEditor(page, 'B3')
  const mark = await commandMark(page)
  // 全选由 Docs 处理，修饰键须与 SDK 的页面平台判断一致（Linux WebKit 的 UA 仍是 Mac）。
  await pressUniverShortcut(page, 'A')
  await waitForCommand(page, mark, { phase: 'executed', id: 'doc.command.select-all' })
  await pressUniverShortcut(page, 'K')
  await test.info().attach('rich-shortcut-commands', { body: JSON.stringify(await probeCommands(page, mark), null, 2), contentType: 'application/json' })
  await waitForCommand(page, mark, { phase: 'executed', id: 'sheet.operation.insert-hyper-link-toolbar' })
  await expect(addressInput(page)).toBeVisible()
  await addressInput(page).fill('/spaces')
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(addressInput(page)).toBeHidden()
  await page.keyboard.press('Enter')
  await waitForCommand(page, mark, { phase: 'executed', id: 'sheets.command.add-rich-hyper-link' })
  await saveAndWait(page)
  expectLink((await savedContent(page, id)).snapshot, 'B3', '富文本资料', '/spaces')

  await openCellEditor(page, 'B3')
  // 同一屏幕坐标此时由上层 Docs 画布接收鼠标，不能等待底层 sheet canvas 收到事件。
  await hoverCell(page, 'B3', { force: true })
  await expect(linkEdit(page)).toBeVisible()
  const updateMark = await commandMark(page)
  await linkEdit(page).click()
  await expect(addressInput(page)).toHaveValue('/spaces')
  await addressInput(page).fill('//example.invalid/private')
  await page.getByPlaceholder('输入文本', { exact: true }).fill('更新富文本')
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByText('请输入合法的链接', { exact: true })).toBeVisible()
  await addressInput(page).fill('HTTPS://EXAMPLE.INVALID/a/../rich')
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(addressInput(page)).toBeHidden()
  await page.keyboard.press('Enter')
  await waitForCommand(page, updateMark, { phase: 'executed', id: 'sheets.command.update-rich-hyper-link' })
  await saveAndWait(page)
  expectLink((await savedContent(page, id)).snapshot, 'B3', '更新富文本', 'https://example.invalid/rich')

  await openCellEditor(page, 'B3')
  const selectionMark = await commandMark(page)
  await pressUniverShortcut(page, 'A')
  await waitForCommand(page, selectionMark, { phase: 'executed', id: 'doc.command.select-all' })
  const before = await probeSnapshot(page)
  const markRejected = await commandMark(page)
  expect(await runFacade(page, async ({ api, workbook, sheet }) => {
    const doc = (api as FacadeApi).getActiveDocument()
    if (doc?.getId() !== '__INTERNAL_EDITOR__DOCS_NORMAL')
      throw new Error('反例必须处于真实活动单元格编辑器')
    const rangeId = doc.save().body?.customRanges?.[0]?.rangeId
    if (rangeId === undefined || rangeId === '')
      throw new Error('反例必须使用已有真实链接')
    const original = JSON.stringify(doc.save())
    for (const action of ['add', 'add-rich', 'update', 'update-rich']) {
      const target = { payload: 'https://name:secret@example.invalid/', display: '不应写入', id: rangeId }
      await api.executeCommand(`sheets.command.${action}-hyper-link`, {
        unitId: workbook.getId(),
        subUnitId: sheet.getSheetId(),
        row: 2,
        column: 1,
        documentId: doc.getId(),
        id: rangeId,
        link: target,
        payload: target,
      })
      if (JSON.stringify(doc.save()) !== original)
        throw new Error('非法命令改变了活动富文本正文')
    }
  })).toEqual({})
  const rejected = await probeCommands(page, markRejected)
  for (const action of ['add', 'add-rich', 'update', 'update-rich'])
    expect(rejected).toContainEqual(expect.objectContaining({ phase: 'before', canceled: true, id: `sheets.command.${action}-hyper-link` }))
  expect(await probeSnapshot(page)).toBe(before)
  await page.keyboard.press('Enter')
  await undoOrRedo(page, 'Z')
  await saveAndWait(page)
  expectLink((await savedContent(page, id)).snapshot, 'B3', '富文本资料', '/spaces')
  await undoOrRedo(page, 'Y')
  await saveAndWait(page)
  expectLink((await savedContent(page, id)).snapshot, 'B3', '更新富文本', 'https://example.invalid/rich')

  await openCellEditor(page, 'B3')
  // 同一屏幕坐标此时由上层 Docs 画布接收鼠标，不能等待底层 sheet canvas 收到事件。
  await hoverCell(page, 'B3', { force: true })
  await expect(linkRemove(page)).toBeVisible()
  const removeMark = await commandMark(page)
  await linkRemove(page).click()
  await page.keyboard.press('Enter')
  await waitForCommand(page, removeMark, { phase: 'executed', id: 'sheets.command.cancel-rich-hyper-link' })
  await saveAndWait(page)
  await reloadAndEnterEditing(page, 'steady')
  const unlinked = cellOf((await savedContent(page, id)).snapshot, 'B3')
  expect(unlinked?.p?.body?.customRanges ?? []).toEqual([])
  expect(unlinked?.p?.body?.dataStream?.trim() ?? unlinked?.v).toBe('更新富文本')
})

const pendingLinkActions = [
  {
    action: 'update',
    text: '新增前文更新资料后文后补',
    ranges: [{ startIndex: 4, endIndex: 7, properties: { url: '/spaces?updated=1' } }],
    apply: async (page: Page) => {
      await expect(linkEdit(page)).toBeVisible()
      await linkEdit(page).click()
      await expect(addressInput(page)).toHaveValue('/spaces')
      await addressInput(page).fill('/spaces?updated=1')
      await page.getByPlaceholder('输入文本', { exact: true }).fill('更新资料')
      await page.getByRole('button', { name: '确认', exact: true }).click()
      await expect(addressInput(page)).toBeHidden()
    },
  },
  {
    action: 'cancel',
    text: '新增前文富文本资料后文后补',
    ranges: [],
    apply: async (page: Page) => {
      await expect(linkRemove(page)).toBeVisible()
      await linkRemove(page).click()
    },
  },
] as const

for (const { action, text, ranges, apply } of pendingLinkActions) {
  test(`US-M5-08 旧菜单出现后进入正文编辑，${action} 链接保留未提交前后文及历史 @test-build`, async ({ page }) => {
    const id = await open(page, `link-pending-${action}`)
    await typeInCell(page, 'B3', '前文富文本资料后文')
    await openCellEditor(page, 'B3')
    const addMark = await commandMark(page)
    await pressUniverShortcut(page, 'A')
    await waitForCommand(page, addMark, { phase: 'executed', id: 'doc.command.select-all' })
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    for (let index = 0; index < 5; index += 1)
      await page.keyboard.press('Shift+ArrowRight')
    await pressUniverShortcut(page, 'K')
    await expect(addressInput(page)).toBeVisible()
    await addressInput(page).fill('/spaces')
    await page.getByRole('button', { name: '确认', exact: true }).click()
    await expect(addressInput(page)).toBeHidden()
    await waitForCommand(page, addMark, { phase: 'executed', id: 'sheets.command.add-rich-hyper-link' })
    await page.keyboard.press('Enter')
    await saveAndWait(page)
    const original = cellOf((await savedContent(page, id)).snapshot, 'B3')
    expect(original?.p?.body).toMatchObject({ dataStream: '前文富文本资料后文\r\n', customRanges: [{ startIndex: 2, endIndex: 6, properties: { url: '/spaces' } }] })

    // 先明确制造本轮缺陷的前置：普通查看菜单已显示，再进入真实 Docs 编辑。
    await hoverCell(page, 'B3')
    await expect(linkRemove(page)).toBeVisible()
    await openCellEditor(page, 'B3')
    expect(await page.evaluate(() => window.__nerveEditorProbe!.univerAPI.getActiveWorkbook().isCellEditing())).toBe(true)
    await pressUniverShortcut(page, 'A')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.insertText('新增')
    await pressUniverShortcut(page, 'A')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.insertText('后补')
    expect(await activeLinkBody(page)).toMatchObject({ dataStream: '新增前文富文本资料后文后补\r\n', customRanges: [{ startIndex: 4, endIndex: 8, properties: { url: '/spaces' } }] })

    // 新增前文使链接向右移动；在默认列宽的 3/4 处移动真实鼠标，命中中间链接。
    // 只读获取画布坐标，不改 popup 类型、焦点或命令；不等待旧菜单自行消失。
    const point = await page.evaluate(() => {
      const cell = window.__nerveEditorProbe!.univerAPI.getActiveWorkbook().getActiveSheet().getRange('B3').getCell()
      const canvas = document.querySelector('canvas[id^="univer-sheet-main-canvas_"]')!.getBoundingClientRect()
      return { x: canvas.left + cell.startX + (cell.endX - cell.startX) * 0.75, y: canvas.top + (cell.startY + cell.endY) / 2 }
    })
    await page.mouse.move(point.x, point.y)
    const mark = await commandMark(page)
    await apply(page)
    await waitForCommand(page, mark, { phase: 'executed', id: `sheets.command.${action}-rich-hyper-link` })
    const body = await activeLinkBody(page)
    expect(body?.dataStream).toBe(`${text}\r\n`)
    expect(body?.customRanges ?? []).toHaveLength(ranges.length)
    expect(body?.customRanges ?? []).toMatchObject([...ranges])
    await page.keyboard.press('Enter')
    await saveAndWait(page)
    const saved = cellOf((await savedContent(page, id)).snapshot, 'B3')
    // 移除最后一个链接后，SDK 可将正文规范为 cell.v；两种存储都必须保留全部文字和链接范围。
    expect(saved?.p?.body?.dataStream?.trim() ?? saved?.v).toBe(text)
    expect(saved?.p?.body?.customRanges ?? []).toEqual(body?.customRanges ?? [])

    await undoOrRedo(page, 'Z')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, id)).snapshot, 'B3')).toEqual(original)
    await undoOrRedo(page, 'Y')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, id)).snapshot, 'B3')).toEqual(saved)
    await reloadAndEnterEditing(page, 'steady')
    expect(cellOf((await savedContent(page, id)).snapshot, 'B3')).toEqual(saved)
    expect(cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'B3')).toEqual(saved)
  })
}

async function activeLinkBody(page: Page) {
  return page.evaluate(() => {
    const api = window.__nerveEditorProbe!.univerAPI
    const doc = api.getActiveDocument()
    if (!api.getActiveWorkbook().isCellEditing() || doc?.getId() !== '__INTERNAL_EDITOR__DOCS_NORMAL')
      throw new Error('必须仍处于活动单元格正文编辑中')
    return doc.save().body
  })
}

test('US-M5-08 富文本工具栏只给中间子串加链，前后文字和范围在重开后保持 @test-build', async ({ page }) => {
  const id = await open(page, 'link-rich-toolbar')
  const toolbar = await ribbon(page, '插入')
  const button = toolbar.getByRole('button', { name: '插入链接', exact: true })
  await expect(button).toBeVisible()
  await typeInCell(page, 'B3', '前文工具栏资料后文')
  await openCellEditor(page, 'B3')
  await pressUniverShortcut(page, 'A')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  for (let index = 0; index < 5; index += 1)
    await page.keyboard.press('Shift+ArrowRight')
  await expect(button).toBeEnabled()
  const mark = await commandMark(page)
  await button.click()
  await test.info().attach('rich-toolbar-commands', { body: JSON.stringify(await probeCommands(page, mark), null, 2), contentType: 'application/json' })
  await expect(addressInput(page)).toBeVisible()
  await addressInput(page).fill('/spaces')
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(addressInput(page)).toBeHidden()
  await page.keyboard.press('Enter')
  await saveAndWait(page)
  const saved = (await savedContent(page, id)).snapshot
  expectLink(saved, 'B3', '前文工具栏资料后文', '/spaces')
  expect(cellOf(saved, 'B3')?.p?.body?.customRanges).toMatchObject([
    { startIndex: 2, endIndex: 6, properties: { url: '/spaces' } },
  ])
  await reloadAndEnterEditing(page, 'steady')
  expect(cellOf((await savedContent(page, id)).snapshot, 'B3')).toEqual(cellOf(saved, 'B3'))
})

test('US-M5-08 原生表单构造工作表、区域和定义名称链接，只读重建后仍定位实际目标 @test-build', async ({ page }) => {
  const id = await open(page, 'link-target')
  const source = (await editorView(page)).sheet
  await appendSheet(page)
  const target = (await editorView(page)).sheet
  expect(target).not.toBe(source)
  await page.evaluate((name) => {
    window.__nerveEditorProbe!.univerAPI.getActiveWorkbook().insertDefinedName('目标区域', `${name}!$F$8:$G$9`)
  }, target)
  await sheetTab(page, source).click()
  for (const [cell, label, type] of [
    ['B3', '跳到目标工作表', '工作表'],
    ['B5', '跳到指定单元格', '单元格'],
    ['B7', '跳到定义的名称', '定义的名称'],
  ] as const) {
    await away(page)
    await typeInCell(page, cell, label)
    await page.keyboard.press('ArrowUp')
    await expect(nameBox(page)).toHaveValue(cell)
    await pressUniverShortcut(page, 'K')
    await expect(addressInput(page)).toBeVisible()
    await page.locator('[data-u-comp="select"]').filter({ hasText: /^链接$/ }).click()
    await page.getByRole('menuitemradio', { name: type, exact: true }).click()
    await chooseInternalDestination(page, type, target)
    await page.getByRole('button', { name: '确认', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认', exact: true })).toBeHidden()
  }
  await saveAndWait(page)
  const saved = (await savedContent(page, id)).snapshot
  for (const cell of ['B3', 'B5', 'B7']) {
    const data = cellOf(saved, cell)
    expect(data?.p?.body?.customRanges?.[0]?.properties?.url).toMatch(cell === 'B7' ? /^#rangeid=/ : cell === 'B5' ? /^#gid=.+&range=F8:G9$/ : /^#gid=[^&]+$/)
    expect(checkCellLinks(data?.p)).toEqual({ ok: true })
  }
  await checkInternalDestinations(page, source, target)
  await exitEditing(page, 'steady')
  await checkInternalDestinations(page, source, target)
  expect((await savedContent(page, id)).snapshot).toEqual(saved)
})

async function chooseInternalDestination(page: Page, type: string, target: string): Promise<void> {
  if (type === '单元格') {
    await expect(page.locator('.univerjs-icon-select-range-icon')).toBeVisible()
    await page.locator('.univerjs-icon-select-range-icon').click()
    const rangeDialog = page.getByRole('dialog', { name: '选择一个数据范围', exact: true })
    await expect(rangeDialog).toBeVisible()
    await rangeDialog.getByPlaceholder('框选范围或输入', { exact: true }).fill(`${target}!F8:G9`)
    await rangeDialog.getByRole('button', { name: '确认', exact: true }).click()
    await expect(rangeDialog).toBeHidden()
  }
  else {
    await page.locator('[data-u-comp="select"]').last().click()
    await page.getByRole('menuitemradio', { name: type === '工作表' ? target : '目标区域', exact: true }).click()
  }
}

async function checkInternalDestinations(page: Page, source: string, target: string): Promise<void> {
  for (const cell of ['B3', 'B5', 'B7']) {
    await sheetTab(page, source).click()
    await hoverCell(page, cell)
    await expect(linkPreview(page)).toBeVisible()
    await expect(linkDestination(page)).toContainText(typeName(cell, target))
    await linkDestination(page).click()
    await expect.poll(async () => (await editorView(page)).sheet).toBe(target)
    if (cell !== 'B3')
      await expect.poll(async () => page.evaluate(() => window.__nerveEditorProbe!.univerAPI.getActiveWorkbook().getActiveSheet().getSelection()?.getActiveRangeList().map(range => range.getA1Notation()))).toEqual(['F8:G9'])
  }
}

function typeName(cell: string, sheet: string): string {
  return cell === 'B3' ? sheet : cell === 'B5' ? 'F8:G9' : '$F$8:$G$9'
}

test('US-M5-08 链接零隐式外站读取，明确点击才打开规范地址并隔离 opener 与 referrer', async ({ page, context }) => {
  const id = await open(page, 'link-navigation')
  const external: string[] = []
  const destinations: string[] = []
  const origin = new URL(page.url()).origin
  context.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== origin)
        external.push(url.href)
      if (url.hostname === 'example.invalid' || url.searchParams.has('link-probe'))
        destinations.push(url.href)
    }
  })
  const response = { contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>链接测试落点</title><p>自制测试页</p>' }
  await context.route('https://example.invalid/**', async route => route.fulfill(response))
  await context.route('**/spaces?link-probe=1', async route => route.fulfill(response))
  await addLink(page, 'B3', '打开外部资料', 'HTTPS://EXAMPLE.INVALID/a/../docs?name=a b')
  await addLink(page, 'B5', '打开本站资料', '/documents/../spaces?link-probe=1')
  await addLink(page, 'B7', '联系邮件负责人', 'mailto:person@example.invalid?subject=a b')
  await saveAndWait(page)
  const savedRevision = (await savedContent(page, id)).revision
  await reloadAndEnterEditing(page, 'steady')
  await exitEditing(page, 'steady')
  expect(external).toEqual([])
  expect(destinations).toEqual([])
  for (const [cell, expected] of [
    ['B3', 'https://example.invalid/docs?name=a%20b'],
    ['B5', `${origin}/spaces?link-probe=1`],
  ] as const) {
    await away(page)
    await hoverCell(page, cell)
    await expect(linkPreview(page)).toBeVisible()
    await expect(linkDestination(page)).toBeVisible()
    const [opened] = await Promise.all([context.waitForEvent('page'), linkDestination(page).click()])
    await expect(opened).toHaveURL(expected)
    await expect(opened).toHaveTitle('链接测试落点')
    expect(await opened.evaluate(() => ({ opener: window.opener === null, referrer: document.referrer }))).toEqual({ opener: true, referrer: '' })
    await opened.close()
  }
  expect(external).toEqual(['https://example.invalid/docs?name=a%20b'])
  expect(destinations).toEqual(['https://example.invalid/docs?name=a%20b', `${origin}/spaces?link-probe=1`])
  // 邮件入口只拦 window.open，避免唤起本机邮件客户端；链接点击仍走真实浮层和 resolver。
  const openedMail: unknown[] = []
  await page.exposeFunction('recordLinkMail', (...args: unknown[]) => {
    openedMail.push(args)
  })
  await page.evaluate(() => {
    const recorder = window as typeof window & { recordLinkMail: (...args: unknown[]) => Promise<void> }
    window.open = (...args) => {
      void recorder.recordLinkMail(...args)
      return null
    }
  })
  await away(page)
  await hoverCell(page, 'B7')
  await expect(linkPreview(page)).toBeVisible()
  await linkDestination(page).click()
  await expect.poll(() => openedMail).toEqual([['mailto:person@example.invalid?subject=a%20b', '_blank', 'noopener,noreferrer']])
  expect((await savedContent(page, id)).revision).toBe(savedRevision)
})

test('US-M5-08 只读的四种链接写命令都被取消，正文、修订和菜单保持 @test-build', async ({ page }) => {
  const id = await open(page, 'link-readonly')
  await addLink(page, 'B3', '只读链接资料', '/spaces')
  await saveAndWait(page)
  await exitEditing(page, 'steady')
  const saved = await savedContent(page, id)
  const before = await probeSnapshot(page)
  const mark = await commandMark(page)
  expect(await runFacade(page, async ({ api, workbook, sheet }) => {
    const target = { payload: 'https://example.invalid/', display: '禁止改写', id: 'read-only' }
    for (const action of ['add', 'add-rich', 'update', 'update-rich']) {
      await api.executeCommand(`sheets.command.${action}-hyper-link`, {
        unitId: workbook.getId(),
        subUnitId: sheet.getSheetId(),
        row: 2,
        column: 1,
        documentId: '__INTERNAL_EDITOR__DOCS_NORMAL',
        id: target.id,
        link: target,
        payload: target,
      })
    }
  })).toEqual({})
  for (const action of ['add', 'add-rich', 'update', 'update-rich'])
    expect(await probeCommands(page, mark)).toContainEqual(expect.objectContaining({ phase: 'before', id: `sheets.command.${action}-hyper-link`, canceled: true }))
  expect(await probeSnapshot(page)).toBe(before)
  expect(await savedContent(page, id)).toEqual(saved)
  await selectCell(page, 'B3', { button: 'right' })
  await expect(page.getByText('添加链接', { exact: true }).filter({ visible: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await selectCell(page, 'B3')
  await pressUniverShortcut(page, 'K')
  await expect(addressInput(page)).toBeHidden()
})
