import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { createUser } from '../../support/database.ts'
import { probeSnapshot } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, exitEditing, openAndEnterEditing, reloadAndEnterEditing, saveAndWait, savedContent, sheetTab, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function previewCsv(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: '导入 CSV', exact: true }).click()
  const picking = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '选择文件', exact: true }).click()
  await (await picking).setFiles({ name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') })
}

async function confirmCsv(page: Page): Promise<void> {
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('CSV 已导入新工作表，后续沿用自动保存。', { exact: true })).toBeVisible()
}

async function historyCommand(page: Page, name: 'undo' | 'redo'): Promise<void> {
  expect(await page.evaluate(async operation => window.__nerveEditorProbe?.univerAPI.executeCommand(`univer.command.${operation}`), name)).toBe(true)
}

test('US-M5-13 CSV 解析失败和预览取消均不改变原工作簿 @test-build', async ({ page }, testInfo) => {
  await loginThroughApi(page, await createUser('csv-cancel'))
  const id = await createSheetThroughApi(page)
  await openAndEnterEditing(page, id)
  await typeInCell(page, 'D4', '原内容')
  const before = await probeSnapshot(page)
  await previewCsv(page, '坏"字段')
  await expect(page.getByRole('alert')).toContainText('CSV 格式不正确')
  expect(await probeSnapshot(page)).toBe(before)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await previewCsv(page, '名称,值\n甲,001')
  await expect(page.getByText('共 2 行、2 列', { exact: true })).toBeVisible()
  await testInfo.attach('CSV预览', { body: await page.screenshot(), contentType: 'image/png' })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(await probeSnapshot(page)).toBe(before)
  await expect(page.getByRole('button', { name: '导入 CSV', exact: true })).toBeFocused()
})

test('US-M5-13 CSV 确认保留正在输入的文字；导入一次撤销/重做并沿原保存重开 @test-build', async ({ page }) => {
  await loginThroughApi(page, await createUser('csv-insert'))
  const id = await createSheetThroughApi(page)
  await openAndEnterEditing(page, id)
  const original = JSON.parse(await probeSnapshot(page)) as Workbook
  await typeInCell(page, 'D4', '刚输入但尚未回车的文字', false)
  await previewCsv(page, '001,=1+2,-12.5,"含,逗号"')
  await expect(page.getByText('共 1 行、4 列', { exact: true })).toBeVisible()
  await confirmCsv(page)
  await expect(sheetTab(page, 'CSV导入')).toBeVisible()
  const inserted = JSON.parse(await probeSnapshot(page)) as Workbook
  const importedId = inserted.sheetOrder.find(sheet => !original.sheetOrder.includes(sheet))
  expect(importedId).toBeDefined()
  expect(inserted.sheetOrder).toHaveLength(original.sheetOrder.length + 1)
  expect(cellOf(inserted, 'D4')?.v).toBe('刚输入但尚未回车的文字')
  expect(cellOf(inserted, 'A1', importedId)).toMatchObject({ v: '001', t: 1 })
  expect(cellOf(inserted, 'B1', importedId)).toMatchObject({ v: '=1+2', t: 1 })
  expect(cellOf(inserted, 'B1', importedId)?.f).toBeUndefined()
  expect(cellOf(inserted, 'C1', importedId)).toMatchObject({ v: -12.5, t: 2 })
  await historyCommand(page, 'undo')
  const undone = JSON.parse(await probeSnapshot(page)) as Workbook
  expect(undone.sheetOrder).toEqual(original.sheetOrder)
  expect(cellOf(undone, 'D4')?.v).toBe('刚输入但尚未回车的文字')
  await historyCommand(page, 'redo')
  expect((JSON.parse(await probeSnapshot(page)) as Workbook).sheetOrder).toEqual(inserted.sheetOrder)
  await saveAndWait(page)
  const stored = await savedContent(page, id)
  expect(stored.snapshot.sheetOrder).toEqual(inserted.sheetOrder)
  expect(cellOf(stored.snapshot, 'D4')?.v).toBe('刚输入但尚未回车的文字')
  await reloadAndEnterEditing(page)
  const reopened = JSON.parse(await probeSnapshot(page)) as Workbook
  expect(reopened.sheetOrder).toEqual(inserted.sheetOrder)
  expect(cellOf(reopened, 'B1', importedId)?.v).toBe('=1+2')
  expect(cellOf(reopened, 'D4')?.v).toBe('刚输入但尚未回车的文字')
})

test('US-M5-12 正式只读入口离线按选表下载真实 UTF-8 CSV，保护公式文本且不改变服务端正文', async ({ page, context }) => {
  await loginThroughApi(page, await createUser('csv-download'))
  const id = await createSheetThroughApi(page, 'CSV往返')
  await openAndEnterEditing(page, id)
  await previewCsv(page, '名称,=1+2,-12.5\n甲,001,2026-11-01')
  await confirmCsv(page)
  await exitEditing(page)
  const before = await savedContent(page, id)
  const writes: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if ((path.endsWith('/content') && request.method() === 'PUT') || (path.endsWith('/edit-lease') && request.method() === 'POST'))
      writes.push(`${request.method()} ${path}`)
  })
  await context.setOffline(true)
  try {
    await expect(page.getByRole('button', { name: '导入 CSV', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click()
    await page.getByLabel('工作表', { exact: true }).selectOption({ label: 'CSV导入' })
    const finished = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载 CSV', exact: true }).click()
    const download = await finished
    expect(await download.failure()).toBeNull()
    expect(download.suggestedFilename()).toBe('CSV往返-CSV导入.csv')
    const path = await download.path()
    expect(path).not.toBeNull()
    expect(await readFile(path)).toEqual(Buffer.from('\uFEFF"名称","\t=1+2","-12.5"\r\n"甲","001","2026-11-01"\r\n', 'utf8'))
  }
  finally {
    await context.setOffline(false)
  }
  const after = await savedContent(page, id)
  expect({ text: after.text, revision: after.revision }).toEqual({ text: before.text, revision: before.revision })
  expect(writes).toEqual([])
})

test('US-M5-13 导入带文档流结构字符的 CSV 明确拒绝：不加表、不改原工作簿、页面无异常（审查疑点 Q-12） @test-build', async ({ page, pageErrors }) => {
  await loginThroughApi(page, await createUser('csv-control-chars'))
  const id = await createSheetThroughApi(page)
  await openAndEnterEditing(page, id)
  const original = await probeSnapshot(page)
  // \b 是 CUSTOM_BLOCK、\u001F 是自定义范围的开始、\u001A 是表格的开始。修复前照原样进入文字格，进入编辑即抛出
  // [DocStructure] missing-custom-block-metadata / unbalanced-custom-range / unbalanced-table（修复记录 S7）
  await previewCsv(page, '"a\bb","x\u001Fy","\u001Az"')
  await expect(page.getByRole('alert')).toContainText('文件里有表格不支持的控制字符（例如退格符或 Ctrl+Z 文件结束符），请删除后重试。')
  await expect(page.getByText(/^共 \d+ 行、\d+ 列$/u)).toHaveCount(0)
  expect(await probeSnapshot(page)).toBe(original)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(await probeSnapshot(page)).toBe(original)
  expect(pageErrors.list()).toEqual([])
})
