import type { Page, Request } from '@playwright/test'
import { documentPagePath, historyPagePath, historyPreviewPagePath } from '@nerve-office/contracts'
import { createUser, editLeaseEndReason, editLeaseEpoch, grantDocument, withDatabase, writeVersion } from '../../support/database.ts'
import { test as base, expect } from '../../support/fixtures.ts'
import { expectHistoryImage, prepareHistory, replaceHistoryFormat } from '../../support/history.ts'
import { readLocalDisk } from '../../support/local-draft.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, openAndEnterEditing, openReader, saveAndWait, savedContent, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 同时收集所有页面/Worker 的请求；CSP 与 pageerror 沿标准夹具，不能因历史链接隐式读取外站。
const test = base.extend<{ externalRequests: void }>({
  externalRequests: [async ({ context, baseURL }, provide, testInfo) => {
    if (baseURL === undefined)
      throw new Error('历史故事缺少被测地址')
    const origin = new URL(baseURL).origin
    const external: string[] = []
    const record = (request: Request) => {
      const url = new URL(request.url())
      if (/^https?:$/.test(url.protocol) && url.origin !== origin)
        external.push(url.href)
    }
    context.on('request', record)
    try {
      await provide()
    }
    finally {
      context.off('request', record)
      await testInfo.attach('history-external-requests', { body: JSON.stringify(external), contentType: 'application/json' })
      expect(external).toEqual([])
    }
  }, { auto: true }],
})
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function recoverFromList(page: Page): Promise<string> {
  await page.getByRole('button', { name: '恢复为副本', exact: true }).click()
  await page.getByRole('button', { name: '恢复到这里', exact: true }).click()
  const link = page.getByRole('link', { name: '打开新副本', exact: true })
  await expect(link).toBeVisible()
  const href = await link.getAttribute('href')
  if (href === null)
    throw new Error('恢复结果没有副本地址')
  return href.split('/').at(-1) ?? ''
}

test('US-M5-10 历史预览只读，结果未知重试只建一份副本，图片格式链接保存重开且原编辑会话不变', async ({ page, context }, testInfo) => {
  const scene = await prepareHistory(page, 'history-roundtrip')
  await openAndEnterEditing(page, scene.documentId, 'steady')
  await typeInCell(page, 'A1', '当前正文仍然保留')
  await saveAndWait(page)
  const original = await savedContent(page, scene.documentId)
  const epoch = await editLeaseEpoch(scene.documentId)
  const listOpened = context.waitForEvent('page')
  await page.getByRole('link', { name: '历史', exact: true }).click()
  const list = await listOpened
  await expect(list).toHaveURL(historyPagePath(scene.documentId))
  const row = list.getByRole('row').filter({ hasText: '修订 2' })
  await expect(row).toContainText(scene.owner.displayName)
  await testInfo.attach('history-list', { body: await list.screenshot(), contentType: 'image/png' })
  const local = await readLocalDisk(page, { userId: scene.owner.id, documentId: scene.documentId })
  const observed: Request[] = []
  const record = (request: Request) => observed.push(request)
  const workers: string[] = []
  const watchWorkers = (opened: Page) => opened.on('worker', worker => workers.push(worker.url()))
  context.on('request', record)
  context.once('page', watchWorkers)
  const previewOpened = context.waitForEvent('page')
  await row.getByRole('link', { name: '只读预览' }).click()
  const preview = await previewOpened
  await waitForEditorAccess(preview, 'read')
  await expect(preview.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0)
  await expectHistoryImage(preview)
  await testInfo.attach('history-read-only-preview', { body: await preview.screenshot(), contentType: 'image/png' })
  await typeInCell(preview, 'A1', '只读不能写')
  await expect(preview.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
  expect(await readLocalDisk(preview, { userId: scene.owner.id, documentId: scene.documentId })).toEqual(local)
  expect(await savedContent(page, scene.documentId)).toEqual(original)
  expect(await editLeaseEpoch(scene.documentId)).toBe(epoch)
  expect(await editLeaseEndReason(scene.documentId)).toBeNull()
  context.off('request', record)
  const requests = observed.filter(request => request.frame().page() === preview).map(request => `${request.method()} ${new URL(request.url()).pathname}`)
  expect(requests).toContain(`GET /api/documents/${scene.documentId}/history/${scene.history.id}/content`)
  expect(requests.filter(value => /^(?:POST|PUT|PATCH|DELETE) |edit-lease|local-key|open-check-failures/.test(value))).toEqual([])
  expect(workers.filter(value => value.includes('outbox.worker'))).toEqual([])
  await testInfo.attach('preview-requests-workers', { body: JSON.stringify({ requests, workers }), contentType: 'application/json' })
  await preview.close()

  const restorePath = `**/api/documents/${scene.documentId}/history/${scene.history.id}/restore`
  const restoreRequests: unknown[] = []
  let first = true
  let committed: { id: string } | undefined
  await list.route(restorePath, async (route) => {
    restoreRequests.push(route.request().postDataJSON() as unknown)
    if (!first) {
      await route.continue()
      return
    }
    first = false
    const response = await route.fetch()
    expect(response.status(), await response.text()).toBe(201)
    committed = await response.json() as { id: string }
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '结果未知对照', requestId: 'history-unknown-outcome' } }) })
  })
  try {
    await row.getByRole('button', { name: '恢复为副本', exact: true }).click()
    await list.getByRole('button', { name: '恢复到这里', exact: true }).click()
    await expect(list.getByText(/暂时无法确认恢复是否完成/)).toBeVisible()
    await list.getByRole('button', { name: '恢复到这里', exact: true }).click()
    await expect(list.getByText('上一次恢复已经完成。')).toBeVisible()
    expect(restoreRequests).toHaveLength(2)
    expect(restoreRequests[0]).toEqual(restoreRequests[1])
    expect(committed).toBeDefined()
    const copyId = committed!.id
    const restored = await savedContent(list, copyId)
    expect(restored.text).toBe(scene.text)
    expect(restored.revision).toBe(1)
    expect(restored.snapshot.id).toBe(original.snapshot.id)
    const copiedOpened = context.waitForEvent('page')
    await list.getByRole('link', { name: '打开新副本', exact: true }).click()
    const copied = await copiedOpened
    await waitForEditorAccess(copied, 'read', 'steady')
    await expectHistoryImage(copied)
    await enterEditing(copied, 'steady')
    await typeInCell(copied, 'A1', '副本可以独立修改')
    await saveAndWait(copied)
    await exitEditing(copied, 'steady')
    await copied.reload()
    await waitForEditorAccess(copied, 'read', 'steady')
    await expectHistoryImage(copied)
    const again = (await savedContent(copied, copyId)).snapshot
    expect(cellOf(again, 'A1')?.v).toBe('副本可以独立修改')
    expect(cellOf(again, 'B12')?.v).toBe(42)
    const style = cellOf(again, 'B12')?.s
    expect(typeof style === 'string' ? again.styles[style] : style).toMatchObject({ bg: { rgb: '#ffe699' }, bl: 1 })
    expect(cellOf(again, 'A13')?.f).toBe('=SUM(B12,8)')
    expect(cellOf(again, 'A11')?.p?.body?.customRanges?.map(range => range.properties?.url)).toEqual(['https://example.invalid/history'])
    expect(await savedContent(page, scene.documentId)).toEqual(original)
    expect(await editLeaseEpoch(scene.documentId)).toBe(epoch)
    await expect(page.locator('#sheet-editor')).toHaveAttribute('data-editor-access', 'edit')
    await copied.close()
  }
  finally {
    await list.unroute(restorePath)
    await list.close()
  }
})

test('US-M5-10 查看者可读当前文档但没有历史入口，直接列表与预览也拒绝', async ({ page, anotherDevice }) => {
  const scene = await prepareHistory(page, 'history-viewer')
  const viewer = await createUser('history-reader')
  await grantDocument(scene.documentId, viewer, 'viewer', scene.owner)
  await loginThroughApi(anotherDevice, viewer)
  await openReader(anotherDevice, scene.documentId, 'steady')
  await expect(anotherDevice.getByRole('link', { name: '历史', exact: true })).toHaveCount(0)
  await anotherDevice.goto(historyPagePath(scene.documentId))
  await expect(anotherDevice.getByText('这份文档的历史已不可用，或你没有查看历史的权限。')).toBeVisible()
  await anotherDevice.goto(historyPreviewPagePath(scene.documentId, scene.history.id))
  await expect(anotherDevice.getByText('这份文档的历史已不可用，或你没有查看历史的权限。')).toBeVisible()
  await expect(anotherDevice.locator('#sheet-editor')).toBeHidden()
})

test('US-M5-10 已打开的预览在撤权和换人后清除；旧画布不能继续显示', async ({ page, anotherDevice }) => {
  const scene = await prepareHistory(page, 'history-revoke')
  const editor = await createUser('history-editor')
  await grantDocument(scene.documentId, editor, 'editor', scene.owner)
  await loginThroughApi(anotherDevice, editor)
  const previewPath = historyPreviewPagePath(scene.documentId, scene.history.id)
  await anotherDevice.goto(previewPath)
  await waitForEditorAccess(anotherDevice, 'read')
  await expectHistoryImage(anotherDevice)
  await actAs(page, 'DELETE', `/api/documents/${scene.documentId}/grants/${editor.id}`)
  await anotherDevice.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(anotherDevice.getByText('这份文档的历史已不可用，或你没有查看历史的权限。')).toBeVisible()
  await expect(anotherDevice.locator('#sheet-editor')).toBeHidden()
  await expect(anotherDevice.locator('canvas[id^="univer-sheet-main-canvas_"]')).toHaveCount(0)

  await grantDocument(scene.documentId, editor, 'editor', scene.owner)
  await anotherDevice.reload()
  await waitForEditorAccess(anotherDevice, 'read')
  await loginThroughApi(anotherDevice, scene.owner)
  await anotherDevice.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(anotherDevice.getByText('登录的账户已经变化，旧预览已关闭。请重新打开历史。')).toBeVisible()
  await expect(anotherDevice.locator('#sheet-editor')).toBeHidden()
})

test('US-M5-10 当前正文自检失败仍能从独立历史恢复有效图片副本', async ({ page, context }) => {
  const scene = await prepareHistory(page, 'history-damaged')
  await writeVersion(scene.documentId, scene.owner, (snapshot) => {
    const resources = snapshot.resources as { name: string, data: string }[]
    const filter = resources.find(resource => resource.name === 'SHEET_FILTER_PLUGIN')
    if (filter === undefined)
      throw new Error('样本没有筛选资源')
    filter.data = '{broken'
  })
  await openReader(page, scene.documentId)
  await expect(page.getByRole('alert').filter({ hasText: '文档数据不完整，已阻止编辑' })).toBeVisible()
  const opened = context.waitForEvent('page')
  await page.getByRole('link', { name: '历史', exact: true }).click()
  const list = await opened
  const copyId = await recoverFromList(list)
  expect((await savedContent(list, copyId)).text).toBe(scene.text)
  await list.goto(documentPagePath(copyId))
  await waitForEditorAccess(list, 'read', 'steady')
  await expectHistoryImage(list)
  await expect(list.getByRole('button', { name: '编辑', exact: true })).toBeVisible()
  await list.close()
})

test('US-M5-10 未知格式历史如实说明，不装载正文、不提供恢复；无历史为空态', async ({ page }) => {
  const scene = await prepareHistory(page, 'history-format')
  await replaceHistoryFormat(scene.history.id, 99)
  await page.goto(historyPagePath(scene.documentId))
  await expect(page.getByText('当前版本不支持这份历史的格式。')).toBeVisible()
  await expect(page.getByRole('button', { name: '恢复为副本', exact: true })).toHaveCount(0)
  const contentRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/content'))
      contentRequests.push(request.url())
  })
  await page.goto(historyPreviewPagePath(scene.documentId, scene.history.id))
  await expect(page.getByText('当前版本不支持这份历史的格式。')).toBeVisible()
  await expect(page.locator('#sheet-editor')).toBeHidden()
  expect(contentRequests).toEqual([])
  await withDatabase(async client => client.query('DELETE FROM document_checkpoints WHERE source_document_id = $1', [scene.documentId]))
  await page.goto(historyPagePath(scene.documentId))
  await expect(page.getByText('最近 7 天没有可用的历史。当前正文不会被当作历史。')).toBeVisible()
})
