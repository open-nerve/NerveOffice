import type { CreatedDocument, DocumentListResponse } from '@nerve-office/contracts'
import type { Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import type { Workbook } from '../../support/sheet.ts'
import { Buffer } from 'node:buffer'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { createFolderIn, createTeamSpace, createUser } from '../../support/database.ts'
import { probeSnapshot } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { actAs, loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, reloadAndEnterEditing, savedContent, sheetTab } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function openCreation(page: Page, user: TestUser, folderId?: string): Promise<void> {
  await loginThroughApi(page, user)
  await page.goto(`/spaces/${user.personalSpaceId}${folderId === undefined ? '' : `/folders/${folderId}`}`)
  await page.getByRole('link', { name: '从 CSV 新建', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeEnabled()
}

async function choose(page: Page, text: string): Promise<void> {
  const picking = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /^(?:选择文件|更换文件)$/ }).click()
  await (await picking).setFiles({ name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') })
}

async function documents(page: Page, spaceId: string, folderId?: string): Promise<DocumentListResponse> {
  const query = new URLSearchParams({ spaceId, ...(folderId === undefined ? {} : { folderId }) })
  const response = await page.request.get(`/api/documents?${query.toString()}`)
  expect(response.status()).toBe(200)
  return await response.json() as DocumentListResponse
}

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error('创建流程缺少预期结果')
  return value
}

const destinations = [
  { name: '空间', folder: async (_user: TestUser): Promise<string | undefined> => undefined },
  { name: '文件夹', folder: async (user: TestUser) => createFolderIn(user.personalSpaceId, user, 'CSV目标') },
]

test('US-M5-13 未登录直接打开 CSV 创建页，真实登录后整页回到原文件夹入口', async ({ page }) => {
  const user = await createUser('csv-login-return')
  const folderId = await createFolderIn(user.personalSpaceId, user, '登录后目标')
  const target = `/documents/new/csv?spaceId=${user.personalSpaceId}&folderId=${folderId}`
  await page.goto(target)
  await page.getByRole('link', { name: '重新登录', exact: true }).click()
  await loginThroughUi(page, user)
  await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeEnabled()
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(target)
  await choose(page, '重新选文件,001')
  await expect(page.getByText('共 1 行、2 列', { exact: true })).toBeVisible()
  expect((await documents(page, user.personalSpaceId, folderId)).items).toHaveLength(0)
})

test('US-M5-13 从 CSV 新建：格式错误和预览取消均不创建文档', async ({ page }) => {
  const user = await createUser('csv-new-cancel')
  await openCreation(page, user)
  const posts: string[] = []
  page.on('request', request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/documents' && posts.push(request.url()))
  await choose(page, '坏"字段')
  await expect(page.getByRole('alert')).toContainText('CSV 格式不正确')
  await expect(page.getByRole('button', { name: '确认创建并导入' })).toBeDisabled()
  await choose(page, '名称,值\n甲,001')
  await expect(page.getByText('共 2 行、2 列', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '取消选择' }).click()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeFocused()
  expect(posts).toEqual([])
  expect((await documents(page, user.personalSpaceId)).items).toHaveLength(0)
})

for (const destination of destinations) {
  test(`US-M5-13 从 CSV 新建到${destination.name}，同页导入并沿原保存通道重开 @test-build`, async ({ page }, testInfo) => {
    const user = await createUser('csv-new-save')
    const folderId = await destination.folder(user)
    await openCreation(page, user, folderId)
    await choose(page, '001,=1+2,-12.5\n甲,"含,逗号",2026-11-01')
    await expect(page.getByText('共 2 行、3 列', { exact: true })).toBeVisible()
    await page.evaluate(() => {
      document.documentElement.dataset.csvSamePage = 'preserved'
    })
    await page.getByRole('button', { name: '确认创建并导入' }).click()
    try {
      await expect(page.getByText('CSV 已导入，请查看页头保存状态。', { exact: true })).toBeVisible()
    }
    finally {
      const facts = await page.evaluate(() => ({
        snapshot: window.__nerveEditorProbe?.snapshot(),
        unitId: window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getId(),
        changeSeq: window.__nerveEditorProbe?.changeSeq(),
        settled: window.__nerveEditorProbe?.formulasSettled(),
        editing: window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().isCellEditing(),
        commands: window.__nerveEditorProbe?.commands(),
      }))
      const documentId = required(new URL(page.url()).pathname.split('/').at(-1))
      await testInfo.attach('CSV新空白交接诊断', { body: Buffer.from(JSON.stringify({ ...facts, documentId, template: sheetSnapshotFor(facts.unitId ?? documentId) })), contentType: 'application/json' })
    }
    await expect(page.locator('html')).toHaveAttribute('data-csv-same-page', 'preserved')
    await expect(sheetTab(page, 'CSV导入')).toBeVisible()
    const id = required(new URL(page.url()).pathname.split('/').at(-1))
    await expect.poll(async () => (await savedContent(page, id)).revision).toBe(2)
    await expect(page.locator('[data-slot="recovery-notice"]')).not.toContainText('本机草稿的清理结果未能确认')
    const stored = await savedContent(page, id)
    const sheet = stored.snapshot.sheetOrder.find(key => stored.snapshot.sheets[key]?.name === 'CSV导入')
    expect(sheet).toBeDefined()
    expect(stored.snapshot.sheetOrder).toHaveLength(2)
    expect(cellOf(stored.snapshot, 'A1', sheet)).toMatchObject({ v: '001', t: 1 })
    expect(cellOf(stored.snapshot, 'B1', sheet)).toMatchObject({ v: '=1+2', t: 1 })
    expect(cellOf(stored.snapshot, 'B1', sheet)?.f).toBeUndefined()
    expect(cellOf(stored.snapshot, 'C1', sheet)).toMatchObject({ v: -12.5, t: 2 })
    expect((await documents(page, user.personalSpaceId, folderId)).items.map(item => item.id)).toEqual([id])
    await testInfo.attach('CSV新建后正式页头', { body: await page.screenshot(), contentType: 'image/png' })
    await reloadAndEnterEditing(page)
    const reopened = JSON.parse(await probeSnapshot(page)) as Workbook
    expect(reopened.sheetOrder).toEqual(stored.snapshot.sheetOrder)
    expect(cellOf(reopened, 'B2', sheet)?.v).toBe('含,逗号')
  })
}

test('US-M5-13 创建响应丢失后同 requestId 核对，只创建一份且重放不自动导入', async ({ page }) => {
  const user = await createUser('csv-new-replay')
  await openCreation(page, user)
  const requests: unknown[] = []
  let created: CreatedDocument | undefined
  const createStatuses: number[] = []
  await page.route('**/api/documents', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    requests.push(route.request().postDataJSON())
    if (created === undefined) {
      const response = await route.fetch()
      createStatuses.push(response.status())
      created = await response.json() as CreatedDocument
      await route.abort('failed')
      return
    }
    await route.continue()
  })
  await choose(page, '不应自动写入,001')
  await page.getByRole('button', { name: '确认创建并导入' }).click()
  await expect(page.getByRole('alert')).toContainText('创建结果尚未确认')
  expect(createStatuses).toEqual([201])
  const document = required(created)
  const original = await savedContent(page, document.id)
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByText('已找到上一次创建的文档，本轮 CSV 未自动导入。', { exact: true })).toBeVisible()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect((await documents(page, user.personalSpaceId)).items.map(item => item.id)).toEqual([document.id])
  expect(await savedContent(page, document.id)).toEqual(original)
  await expect(page.getByRole('link', { name: '打开已创建文档' })).toHaveAttribute('href', `/documents/${document.id}`)
})

test('US-M5-13 创建后加载失败保留文档入口，重试打开导入而不重复创建', async ({ page }) => {
  const user = await createUser('csv-new-open')
  await openCreation(page, user)
  let failContent = true
  const posts: string[] = []
  page.on('request', request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/documents' && posts.push(request.url()))
  await page.route('**/api/documents/*/content', async (route) => {
    if (failContent && route.request().method() === 'GET')
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '本轮加载失败对照', requestId: 'csv-load-failure' } }) })
    else
      await route.continue()
  })
  await choose(page, '保留后重试,001')
  await page.getByRole('button', { name: '确认创建并导入' }).click()
  await expect(page.getByRole('alert')).toContainText('文档已创建，但暂时无法打开')
  await expect(page.getByRole('link', { name: '打开已创建文档' })).toBeVisible()
  expect(posts).toHaveLength(1)
  failContent = false
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByText('CSV 已导入，请查看页头保存状态。', { exact: true })).toBeVisible()
  expect(posts).toHaveLength(1)
  const list = await documents(page, user.personalSpaceId)
  expect(list.items).toHaveLength(1)
  const id = required(list.items[0]?.id)
  await expect.poll(async () => (await savedContent(page, id)).revision).toBe(2)
})

test('US-M5-13 丢失创建响应后失去新建权限，原请求仍能核对只读文档，零自动导入', async ({ page, anotherDevice }) => {
  const user = await createUser('csv-replay-viewer')
  const lead = await createUser('csv-replay-lead')
  const space = await createTeamSpace('CSV重放权限', lead, [[lead, 'admin'], [user, 'editor']])
  await loginThroughApi(page, user)
  await page.goto(`/spaces/${space.id}`)
  await page.getByRole('link', { name: '从 CSV 新建', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeEnabled()
  const requests: unknown[] = []
  const createStatuses: number[] = []
  let created: CreatedDocument | undefined
  await page.route('**/api/documents', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    requests.push(route.request().postDataJSON())
    if (created === undefined) {
      const response = await route.fetch()
      createStatuses.push(response.status())
      created = await response.json() as CreatedDocument
      await route.abort('failed')
      return
    }
    await route.continue()
  })
  await choose(page, '应保持空白,001')
  await page.getByRole('button', { name: '确认创建并导入' }).click()
  await expect(page.getByRole('alert')).toContainText('创建结果尚未确认')
  expect(createStatuses).toEqual([201])
  const id = required(created).id
  const original = await savedContent(page, id)
  const session = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  await loginThroughApi(anotherDevice, lead)
  await actAs(anotherDevice, 'PUT', `/api/spaces/${space.id}/members/${user.id}`, { role: 'viewer' })
  const afterSession = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  expect(afterSession.csrfToken).toBe(session.csrfToken)
  const replayed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/documents' && response.request().method() === 'POST')
  await page.getByRole('button', { name: '重试', exact: true }).click()
  expect(await (await replayed).json()).toMatchObject({ id, replayed: true, permissions: { canEdit: false } })
  await expect(page.getByText('已找到上一次创建的文档，本轮 CSV 未自动导入。', { exact: true })).toBeVisible()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect((await documents(page, space.id)).items.map(item => item.id)).toEqual([id])
  expect(await savedContent(page, id)).toEqual(original)
  await expect(page.getByRole('link', { name: '打开已创建文档' })).toHaveAttribute('href', `/documents/${id}`)
  await expect(page.locator('#sheet-editor')).toBeHidden()
})
