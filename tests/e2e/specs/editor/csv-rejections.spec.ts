import { Buffer } from 'node:buffer'
import { chooseCsv, documentsAt } from '../../support/csv.ts'
import { createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, saveAndWait, savedContent, sheetTab, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 文件约 3.3 MB，字段与格数合法；JSON 中的反斜杠加倍后超过原 5 MiB 快照上限。 */
function snapshotOverflowCsv(): string {
  return Array.from<string>({ length: 100 }).fill('\\'.repeat(32_767)).join('\n')
}

test('US-M5-13 公开 CSV 导入拒绝无效编码、超限矩形和最终快照超限，原正文始终保留', async ({ page }) => {
  await loginThroughApi(page, await createUser('csv-reject-import'))
  const id = await createSheetThroughApi(page)
  await openAndEnterEditing(page, id)
  await typeInCell(page, 'A1', '必须保留的原正文')
  await saveAndWait(page)
  const before = await savedContent(page, id)
  const dialog = page.getByRole('dialog', { name: '导入 CSV', exact: true })
  for (const invalid of [
    { data: new Uint8Array([0xC3, 0x28]), message: '文件不是有效的 UTF-8 文本' },
    { data: Array.from<string>({ length: 101 }).fill(Array.from<string>({ length: 1000 }).fill('x').join(',')).join('\n'), message: '超过 100,000 个单元格' },
  ]) {
    await page.getByRole('button', { name: '导入 CSV', exact: true }).click()
    await chooseCsv(page, invalid.data)
    await expect(dialog.getByRole('alert')).toContainText(invalid.message)
    await expect(dialog.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(sheetTab(page, 'CSV导入')).toHaveCount(0)
    await saveAndWait(page)
    expect(await savedContent(page, id)).toEqual(before)
  }
  const large = snapshotOverflowCsv()
  expect(Buffer.byteLength(large, 'utf8')).toBeLessThan(5 * 1024 * 1024)
  await page.getByRole('button', { name: '导入 CSV', exact: true }).click()
  await chooseCsv(page, large)
  await expect(dialog.getByText('共 100 行、1 列', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('加入 CSV 后会超过文档容量')
  await expect(sheetTab(page, 'CSV导入')).toHaveCount(0)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await saveAndWait(page)
  expect(await savedContent(page, id)).toEqual(before)
})

test('US-M5-13 CSV 新建在 JSON 膨胀超限时零 POST、零文档', async ({ page }) => {
  const user = await createUser('csv-reject-create')
  await loginThroughApi(page, user)
  await page.goto(`/spaces/${user.personalSpaceId}`)
  await page.getByRole('link', { name: '从 CSV 新建', exact: true }).click()
  const posts: string[] = []
  page.on('request', request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/documents' && posts.push(request.url()))
  await chooseCsv(page, snapshotOverflowCsv())
  await expect(page.getByRole('alert')).toContainText('加入 CSV 后会超过文档容量')
  await expect(page.getByRole('button', { name: '确认创建并导入', exact: true })).toBeDisabled()
  expect(posts).toEqual([])
  expect((await documentsAt(page, user.personalSpaceId)).items).toEqual([])
})

test('US-M5-13 CSV 新建预览后失去创建权限，原 CSRF 不变仍拒绝且零创建', async ({ page, anotherDevice }) => {
  const user = await createUser('csv-create-denied')
  const lead = await createUser('csv-create-lead')
  const space = await createTeamSpace('CSV新建拒绝', lead, [[lead, 'admin'], [user, 'editor']])
  await loginThroughApi(page, user)
  await loginThroughApi(anotherDevice, lead)
  await page.goto(`/spaces/${space.id}`)
  await page.getByRole('link', { name: '从 CSV 新建', exact: true }).click()
  await chooseCsv(page, '不应创建')
  await expect(page.getByText('共 1 行、1 列', { exact: true })).toBeVisible()
  const beforeSession = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  await actAs(anotherDevice, 'PUT', `/api/spaces/${space.id}/members/${user.id}`, { role: 'viewer' })
  const afterSession = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  expect(afterSession.csrfToken).toBe(beforeSession.csrfToken)
  const posts: string[] = []
  page.on('request', request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/documents' && posts.push(request.url()))
  await page.getByRole('button', { name: '确认创建并导入', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('当前没有在此位置创建文档的权限')
  expect(posts).toEqual([])
  expect((await documentsAt(page, space.id)).items).toEqual([])
})

test('US-M5-13 CSV 导入预览后登录失效，确认不能插表且另一设备看到原正文', async ({ page, anotherDevice }) => {
  const user = await createUser('csv-import-signed-out')
  await loginThroughApi(page, user)
  await loginThroughApi(anotherDevice, user)
  const id = await createSheetThroughApi(page)
  await openAndEnterEditing(page, id)
  await typeInCell(page, 'A1', '会话变化也必须保留')
  await saveAndWait(page)
  const before = await savedContent(anotherDevice, id)
  await page.getByRole('button', { name: '导入 CSV', exact: true }).click()
  await chooseCsv(page, '不应插入的新内容')
  const dialog = page.getByRole('dialog', { name: '导入 CSV', exact: true })
  await expect(dialog.getByText('共 1 行、1 列', { exact: true })).toBeVisible()
  await actAs(page, 'POST', '/api/auth/logout')
  const deniedSession = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session' && response.status() === 401)
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  expect((await deniedSession).status()).toBe(401)
  await expect(dialog).toHaveCount(0)
  await expect(sheetTab(page, 'CSV导入')).toHaveCount(0)
  expect(await savedContent(anotherDevice, id)).toEqual(before)
})
