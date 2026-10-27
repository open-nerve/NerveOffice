import type { Page } from '@playwright/test'
import { documentHistoryListResponseSchema, historyPreviewPagePath, sheetSnapshotFor } from '@nerve-office/contracts'
import { saveAssetSnapshot } from '../../support/asset-protocol.ts'
import { createDocument, createUser, expireSessions, withDatabase } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { expectHistoryImage, prepareHistory } from '../../support/history.ts'
import { loginThroughApi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT, savedContent, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

interface SessionTimes {
  readonly id: string
  readonly last_seen_at: Date
  readonly idle_expires_at: Date
}

async function times(userId: string, stale = false): Promise<SessionTimes> {
  return withDatabase(async (client) => {
    if (stale)
      await client.query('UPDATE auth_sessions SET last_seen_at=now()-interval \'2 minutes\', idle_expires_at=now()+interval \'10 minutes\' WHERE user_id=$1 AND revoked_at IS NULL', [userId])
    const rows = (await client.query<SessionTimes>('SELECT id,last_seen_at,idle_expires_at FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY id', [userId])).rows
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      throw new Error('预览故事必须只有一条未撤销的登录')
    return row
  })
}
async function plainHistory(page: Page) {
  const owner = await createUser('history-idle-plain')
  await loginThroughApi(page, owner)
  const documentId = await createDocument(owner, '无图历史')
  const unitId = (await savedContent(page, documentId)).snapshot.id
  const snapshot = JSON.parse(sheetSnapshotFor(unitId)) as { sheetOrder: string[], sheets: Record<string, { cellData: Record<string, unknown> }> }
  const first = snapshot.sheetOrder[0]
  const sheet = first === undefined ? undefined : snapshot.sheets[first]
  if (sheet === undefined)
    throw new Error('历史样本缺少工作表')
  sheet.cellData = { 0: { 0: { v: '静置的历史正文' } } }
  await saveAssetSnapshot(page, documentId, JSON.stringify(snapshot))
  const response = await page.request.get(`/api/documents/${documentId}/history`)
  expect(response.status()).toBe(200)
  const history = documentHistoryListResponseSchema.parse(await response.json()).items.find(item => item.revision === 2)
  if (history === undefined)
    throw new Error('无图样本没有生成小时历史')
  return { owner, documentId, history }
}

const scenes = [
  { label: '无图', pictures: false, prepare: plainHistory, assertCanvas: async (page: Page) => expect(page.locator('#sheet-editor')).toBeVisible() },
  { label: '含图', pictures: true, prepare: async (page: Page) => prepareHistory(page, 'history-idle-images'), assertCanvas: expectHistoryImage },
]
for (const scenario of scenes) {
  test(`US-M5-10 ${scenario.label}历史静置与自动重载不续期，主动重试续期，空闲到期关闭`, async ({ page }, testInfo) => {
    const { pictures } = scenario
    const scene = await scenario.prepare(page)
    const detail = `/api/documents/${scene.documentId}/history/${scene.history.id}`
    // 合法大写深链接也经过真实客户端/服务端身份规范化。
    await page.goto(historyPreviewPagePath(scene.documentId.toUpperCase(), scene.history.id.toUpperCase()))
    await waitForEditorAccess(page, 'read')
    await scenario.assertCanvas(page)
    const requests: string[] = []
    page.on('request', request => requests.push(`${request.method()} ${new URL(request.url()).pathname}`))
    const beforeIdle = await times(scene.owner.id, true)
    // 等真实的 30 秒周期；不拨浏览器或服务端时钟，不伪造刷新调用。
    await page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session/check', { timeout: 40_000 })
    await waitForEditorAccess(page, 'read')
    await scenario.assertCanvas(page)
    const afterIdle = await times(scene.owner.id)
    expect(afterIdle).toEqual(beforeIdle)
    expect(requests).toContain(`GET ${detail}`)
    expect(requests.some(path => path.startsWith('GET /api/assets/'))).toBe(pictures)
    expect(requests).not.toContain('GET /api/auth/session')

    async function failRecheck(): Promise<void> {
      await page.route(`**${detail}`, async route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '预览重载对照', requestId: 'history-reload' } }) }))
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
      await expect(page.locator('#sheet-editor')).toBeHidden()
      await expect(page.locator('canvas[id^="univer-sheet-main-canvas_"]')).toHaveCount(0)
      await page.unroute(`**${detail}`)
    }
    await failRecheck()
    const beforeReload = await times(scene.owner.id, true)
    const content = page.waitForResponse(response => new URL(response.url()).pathname === `${detail}/content`)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    expect((await content).status()).toBe(200)
    await waitForEditorAccess(page, 'read')
    await scenario.assertCanvas(page)
    const afterReload = await times(scene.owner.id)
    expect(afterReload).toEqual(beforeReload)
    expect(requests).not.toContain('GET /api/auth/session')

    await failRecheck()
    const beforeClick = await times(scene.owner.id, true)
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await waitForEditorAccess(page, 'read')
    await scenario.assertCanvas(page)
    const afterClick = await times(scene.owner.id)
    expect(afterClick.last_seen_at.getTime()).toBeGreaterThan(beforeClick.last_seen_at.getTime())
    expect(afterClick.idle_expires_at.getTime()).toBeGreaterThan(beforeClick.idle_expires_at.getTime())
    expect(requests.filter(path => path === 'GET /api/auth/session')).toHaveLength(1)

    await expireSessions(scene.owner)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(page.getByRole('alert')).toContainText('登录已失效')
    await expect(page.locator('#sheet-editor')).toBeHidden()
    await expect(page.locator('canvas[id^="univer-sheet-main-canvas_"]')).toHaveCount(0)
    const endedCount = requests.length
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    expect(requests).toHaveLength(endedCount)
    await testInfo.attach('history-preview-session-activity', { body: JSON.stringify({ pictures, beforeIdle, afterIdle, beforeReload, afterReload, beforeClick, afterClick, endedCount, requests }), contentType: 'application/json' })
  })
}
