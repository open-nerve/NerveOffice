// 与生产容器共用：所有输入、撤销、重开与下载走公开页面，没有测试构建探针。
import type { TestUser } from '../../support/database.ts'
import { Buffer } from 'node:buffer'
import { chooseCsv, documentsAt, downloadCsv } from '../../support/csv.ts'
import { createFolderIn, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, expectFoundOnce, openAndEnterEditing, reloadAndEnterEditing, saveAndWait, savedContent, selectCell, sheetTab, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test('US-M5-13 公开 CSV 导入保留未提交正文，键盘一次撤销重做，保存重开与下载一致', async ({ page }) => {
  await loginThroughApi(page, await createUser('csv-public-import'))
  const id = await createSheetThroughApi(page, '公开CSV导入')
  await openAndEnterEditing(page, id)
  const original = await savedContent(page, id)
  await typeInCell(page, 'D4', '原表尚未回车的文字', false)
  await page.getByRole('button', { name: '导入 CSV', exact: true }).click()
  await chooseCsv(page, '001,=1+2,-12.5,"含,逗号"')
  await expect(page.getByText('共 1 行、4 列', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(sheetTab(page, 'CSV导入')).toBeVisible()
  await saveAndWait(page)
  const inserted = await savedContent(page, id)
  const importedId = inserted.snapshot.sheetOrder.find(key => !original.snapshot.sheetOrder.includes(key))
  expect(importedId).toBeDefined()
  expect(inserted.snapshot.sheetOrder).toHaveLength(2)
  expect(cellOf(inserted.snapshot, 'D4')?.v).toBe('原表尚未回车的文字')
  expect(cellOf(inserted.snapshot, 'A1', importedId)).toMatchObject({ v: '001', t: 1 })
  expect(cellOf(inserted.snapshot, 'B1', importedId)).toMatchObject({ v: '=1+2', t: 1 })
  expect(cellOf(inserted.snapshot, 'B1', importedId)?.f).toBeUndefined()
  expect(cellOf(inserted.snapshot, 'C1', importedId)).toMatchObject({ v: -12.5, t: 2 })
  await selectCell(page, 'C3')
  await pressUniverShortcut(page, 'Z')
  await expect(sheetTab(page, 'CSV导入')).toHaveCount(0)
  await saveAndWait(page)
  const undone = await savedContent(page, id)
  expect(undone.snapshot.sheetOrder).toEqual(original.snapshot.sheetOrder)
  expect(cellOf(undone.snapshot, 'D4')?.v).toBe('原表尚未回车的文字')
  await selectCell(page, 'C3')
  await pressUniverShortcut(page, 'Shift+Z')
  await expect(sheetTab(page, 'CSV导入')).toBeVisible()
  await saveAndWait(page)
  expect((await savedContent(page, id)).snapshot.sheetOrder).toEqual(inserted.snapshot.sheetOrder)
  await reloadAndEnterEditing(page)
  await sheetTab(page, 'CSV导入').click()
  await expectFoundOnce(page, '含,逗号')
  const download = await downloadCsv(page, 'CSV导入')
  expect(download.name).toBe('公开CSV导入-CSV导入.csv')
  expect(download.bytes).toEqual(Buffer.from('\uFEFF"001","\t=1+2","-12.5","含,逗号"\r\n', 'utf8'))
})

const destinations = [
  { name: '空间', folder: async (_user: TestUser): Promise<string | undefined> => undefined },
  { name: '文件夹', folder: async (user: TestUser) => createFolderIn(user.personalSpaceId, user, '公开CSV目标') },
]

for (const destination of destinations) {
  test(`US-M5-13 公开 CSV 新建到${destination.name}，同页交接后保存、重开与下载`, async ({ page }) => {
    const user = await createUser('csv-public-create')
    const folderId = await destination.folder(user)
    await loginThroughApi(page, user)
    await page.goto(`/spaces/${user.personalSpaceId}${folderId === undefined ? '' : `/folders/${folderId}`}`)
    await page.getByRole('link', { name: '从 CSV 新建', exact: true }).click()
    await chooseCsv(page, '新建唯一标记,001,=1+2\n尾行,-2.5,"含,逗号"')
    await expect(page.getByText('共 2 行、3 列', { exact: true })).toBeVisible()
    await page.evaluate(() => {
      document.documentElement.dataset.csvPublic = 'same-document'
    })
    await page.getByRole('button', { name: '确认创建并导入', exact: true }).click()
    await expect(page.getByText('CSV 已导入，请查看页头保存状态。', { exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-csv-public', 'same-document')
    await saveAndWait(page)
    const id = new URL(page.url()).pathname.slice('/documents/'.length)
    const list = await documentsAt(page, user.personalSpaceId, folderId)
    expect(list.items.map(item => item.id)).toEqual([id])
    const stored = await savedContent(page, id)
    const importedId = stored.snapshot.sheetOrder.find(key => stored.snapshot.sheets[key]?.name === 'CSV导入')
    expect(importedId).toBeDefined()
    expect(stored.snapshot.sheetOrder).toHaveLength(2)
    expect(cellOf(stored.snapshot, 'A1', importedId)?.v).toBe('新建唯一标记')
    expect(cellOf(stored.snapshot, 'B1', importedId)).toMatchObject({ v: '001', t: 1 })
    expect(cellOf(stored.snapshot, 'C1', importedId)).toMatchObject({ v: '=1+2', t: 1 })
    expect(cellOf(stored.snapshot, 'C1', importedId)?.f).toBeUndefined()
    expect(cellOf(stored.snapshot, 'B2', importedId)).toMatchObject({ v: -2.5, t: 2 })
    await reloadAndEnterEditing(page)
    await sheetTab(page, 'CSV导入').click()
    await expectFoundOnce(page, '新建唯一标记')
    const download = await downloadCsv(page, 'CSV导入')
    expect(download.name).toBe(`${list.items[0]?.title}-CSV导入.csv`)
    expect(download.bytes).toEqual(Buffer.from('\uFEFF"新建唯一标记","001","\t=1+2"\r\n"尾行","-2.5","含,逗号"\r\n', 'utf8'))
  })
}
