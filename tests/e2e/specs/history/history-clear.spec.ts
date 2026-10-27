import { randomUUID } from 'node:crypto'
import { documentHistoryListResponseSchema, documentPagePath, historyPagePath } from '@nerve-office/contracts'
import { editLeaseEndReason, editLeaseEpoch, withDatabase } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { expectHistoryImage, prepareHistory } from '../../support/history.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, openAndEnterEditing, saveAndWait, savedContent, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test('US-M5-11 清除历史使已打开的预览失效，原件与恢复副本仍可编辑图片且本小时不重采', async ({ page, context }, testInfo) => {
  const scene = await prepareHistory(page, 'history-clear')
  await openAndEnterEditing(page, scene.documentId, 'steady')
  const original = await savedContent(page, scene.documentId)
  const epoch = await editLeaseEpoch(scene.documentId)
  const list = await context.newPage()
  await list.goto(historyPagePath(scene.documentId))
  const previewOpened = context.waitForEvent('page')
  await list.getByRole('link', { name: '只读预览', exact: true }).click()
  const preview = await previewOpened
  await waitForEditorAccess(preview, 'read')
  await expectHistoryImage(preview)

  await list.getByRole('button', { name: '恢复为副本', exact: true }).click()
  await list.getByRole('button', { name: '恢复到这里', exact: true }).click()
  const copyLink = list.getByRole('link', { name: '打开新副本', exact: true })
  await expect(copyLink).toBeVisible()
  const copyHref = await copyLink.getAttribute('href')
  expect(copyHref).not.toBeNull()
  const copyId = copyHref!.split('/').at(-1)!
  const copyBefore = await savedContent(list, copyId)
  await list.getByRole('button', { name: '清除历史', exact: true }).click()
  const dialog = list.getByRole('dialog', { name: '清除文档历史' })
  await expect(dialog).toContainText('清除后无法撤销')
  await dialog.getByRole('button', { name: '确认清除' }).click()
  await expect(list.getByText('已清除 1 条历史。', { exact: true })).toBeVisible()
  await expect(list.getByText(/最近 7 天没有可用的历史/)).toBeVisible()
  await expect(list.getByRole('heading', { name: '文档历史', level: 1 })).toBeFocused()
  await testInfo.attach('history-cleared', { body: await list.screenshot(), contentType: 'image/png' })

  await preview.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(preview.getByText('这份文档的历史已不可用，或你没有查看历史的权限。')).toBeVisible()
  await expect(preview.locator('canvas[id^="univer-sheet-main-canvas_"]')).toHaveCount(0)
  expect(await savedContent(page, scene.documentId)).toEqual(original)
  expect(await savedContent(list, copyId)).toEqual(copyBefore)
  expect(await editLeaseEpoch(scene.documentId)).toBe(epoch)
  expect(await editLeaseEndReason(scene.documentId)).toBeNull()
  await expect(page.locator('#sheet-editor')).toHaveAttribute('data-editor-access', 'edit')
  await expectHistoryImage(page)
  await typeInCell(page, 'A1', '清除后原件仍可编辑')
  await saveAndWait(page)
  expect(cellOf((await savedContent(page, scene.documentId)).snapshot, 'A1')?.v).toBe('清除后原件仍可编辑')
  const response = await page.request.get(`/api/documents/${scene.documentId}/history`)
  expect(response.status()).toBe(200)
  expect(documentHistoryListResponseSchema.parse(await response.json()).items).toEqual([])

  await list.goto(documentPagePath(copyId))
  await waitForEditorAccess(list, 'read', 'steady')
  await expectHistoryImage(list)
  await enterEditing(list, 'steady')
  await typeInCell(list, 'A1', '清除后副本仍可编辑')
  await saveAndWait(list)
  await exitEditing(list, 'steady')
  await list.reload()
  await waitForEditorAccess(list, 'read', 'steady')
  await expectHistoryImage(list)
  expect(cellOf((await savedContent(list, copyId)).snapshot, 'A1')?.v).toBe('清除后副本仍可编辑')
  await preview.close()
  await list.close()
})

test('US-M5-11 清除已提交但响应丢失，当前确认不能再次删除后来新增的历史', async ({ page }, testInfo) => {
  const scene = await prepareHistory(page, 'history-clear-unknown')
  const insertLater = await laterHistoryFixture(scene.history.id)
  await page.goto(historyPagePath(scene.documentId))
  const routePath = `**/api/documents/${scene.documentId}/history`
  let deletes = 0
  let laterId: string | undefined
  await page.route(routePath, async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue()
      return
    }
    deletes += 1
    const response = await route.fetch()
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json()).toEqual({ cleared: 1 })
    laterId = await insertLater()
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '清除回包丢失对照', requestId: 'history-clear-unknown' } }) })
  })
  try {
    await page.getByRole('button', { name: '清除历史', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '清除文档历史' })
    await dialog.getByRole('button', { name: '确认清除' }).click()
    await expect(dialog.getByRole('alert')).toContainText('清除可能已生效，已重新读取历史')
    const retry = dialog.getByRole('button', { name: '确认清除' })
    await expect(retry).toHaveAttribute('aria-disabled', 'true')
    // aria-disabled 保持可聚焦；直接派发 click 也必须由业务守卫拒绝。
    await retry.dispatchEvent('click')
    expect(deletes).toBe(1)
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('row').filter({ hasText: '后续小时的新历史' })).toBeVisible()
    const listed = documentHistoryListResponseSchema.parse(await (await page.request.get(`/api/documents/${scene.documentId}/history`)).json())
    expect(listed.items.map(item => item.id)).toEqual([laterId])
    await page.getByRole('button', { name: '清除历史', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '确认清除' })).toHaveAttribute('aria-disabled', 'false')
    expect(deletes).toBe(1)
    await testInfo.attach('history-clear-unknown-protection', { body: JSON.stringify({ deletes, laterId, remaining: listed.items.map(item => item.id) }), contentType: 'application/json' })
    await dialog.getByRole('button', { name: '取消' }).click()
  }
  finally {
    await page.unroute(routePath)
  }
})

/** 下一小时的独立采样夹具；不等一小时、不关闭不可变约束，也不改原记录/正文。正式同小时保存另由上面的故事验证。 */
async function laterHistoryFixture(historyId: string): Promise<() => Promise<string>> {
  const material = await withDatabase(async (client) => {
    const row = (await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(c) AS data FROM document_checkpoints c WHERE id=$1', [historyId])).rows[0]!
    const assets = (await client.query<{ asset_id: string }>('SELECT asset_id FROM document_checkpoint_assets WHERE checkpoint_id=$1', [historyId])).rows
    return { data: row.data, assets }
  })
  const timestamp = material.data.created_at
  if (typeof timestamp !== 'string')
    throw new Error('采样夹具缺少创建时刻')
  const created = new Date(Date.parse(timestamp) + 3600_000)
  return async () => withDatabase(async (client) => {
    const id = randomUUID()
    await client.query('BEGIN')
    try {
      const hour = new Date(Math.floor(created.getTime() / 3600_000) * 3600_000).toISOString()
      await client.query('INSERT INTO document_history_buckets (document_id,hour_bucket) VALUES ($1,$2) ON CONFLICT DO NOTHING', [material.data.source_document_id, hour])
      await client.query('INSERT INTO document_checkpoints SELECT * FROM jsonb_populate_record(NULL::document_checkpoints,$1::jsonb)', [JSON.stringify({
        ...material.data,
        id,
        title: '后续小时的新历史',
        hour_bucket: hour,
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + 168 * 3600_000).toISOString(),
      })])
      for (const asset of material.assets)
        await client.query('INSERT INTO document_checkpoint_assets (checkpoint_id,asset_id) VALUES ($1,$2)', [id, asset.asset_id])
      await client.query('COMMIT')
      return id
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
}
