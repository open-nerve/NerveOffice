// API 重启后已确认的数据不丢（US-M1-10，A09 的 API 重启部分，P5 设计 §3.6）：强制结束后端（SIGKILL）再启动。
// - 已确认的保存完整；
// - 保存进行中被打断：没有提交；页面再保存一次沿用同一个 requestId，修订号只加一；
// - 已经提交、回包丢了：重试返回原来的结果，不重复写入。
// 单独的 Playwright 项目 restart：全部浏览器项目跑完之后才执行，强制结束后端不会打断别的用例（playwright.config.ts）。
import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { restartApi } from '../../support/api-process.ts'
import { createUser, withDatabase } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, openEditor, saveAndWait, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

/** 后端连接数据库时的应用名（apps/api 的连接池） */
const API_APPLICATION_NAME = 'nerve-office-api'

/** 后端在等锁的会话数（测试直连数据库锁住文档行时，后端的保存事务停在这里） */
async function apiSessionsWaitingForLock(): Promise<number> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = \'Lock\'',
      [API_APPLICATION_NAME],
    )
    return Number(rows[0]?.count)
  })
}

/** 这个页面发出的保存请求的 requestId，按发出的顺序 */
function recordSaveRequests(page: Page): string[] {
  const requestIds: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'PUT' && url.pathname.endsWith('/content'))
      requestIds.push(url.searchParams.get('requestId') ?? '')
  })
  return requestIds
}

test.describe('US-M1-10 API 重启后已确认的数据不丢', () => {
  // 共用一个后端：一个接一个执行
  test.describe.configure({ mode: 'serial' })

  test('已确认的保存：强制结束后端再启动，重新打开时内容与修订号都在', async ({ page, request }) => {
    await loginThroughApi(page, await createUser('restart-confirmed'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    await typeInCell(page, 'A1', '重启之前已确认')
    await saveAndWait(page)
    const confirmed = await savedContent(page, documentId)

    await restartApi(request)
    await openEditor(page, documentId)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    const reopened = await savedContent(page, documentId)
    expect(reopened.revision).toBe(confirmed.revision)
    expect(reopened.text).toBe(confirmed.text)
    expect(cellOf(reopened.snapshot, 'A1')?.v).toBe('重启之前已确认')
  })

  test('保存进行中被打断：没有提交；页面再保存一次沿用同一个 requestId，修订号只加一', async ({ page, request }) => {
    await loginThroughApi(page, await createUser('restart-interrupted'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const before = await savedContent(page, documentId)
    const saves = recordSaveRequests(page)
    await typeInCell(page, 'A1', '被打断的保存')

    // 测试直连数据库锁住文档行：后端的保存事务停在等锁，这时强制结束后端
    await withDatabase(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('SELECT 1 FROM documents WHERE id = $1 FOR UPDATE', [documentId])
        await saveButton(page).click()
        await expect.poll(apiSessionsWaitingForLock, { timeout: 15_000 }).toBeGreaterThan(0)
        await restartApi(request)
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
    // 被强制结束的后端的事务：拿到锁之后发现连接已经断了，回滚，没有提交
    await expect.poll(apiSessionsWaitingForLock).toBe(0)
    await expect(saveStatus(page)).toHaveText('保存失败')
    expect((await savedContent(page, documentId)).revision).toBe(before.revision)

    await saveAndWait(page)
    expect(saves).toHaveLength(2)
    expect(saves[1]).toBe(saves[0])
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(before.revision + 1)
    expect(cellOf(saved.snapshot, 'A1')?.v).toBe('被打断的保存')
  })

  test('已经提交、回包丢了：重启之后用同一个 requestId 重试，返回原来的结果，不重复写入', async ({ page, request }) => {
    await loginThroughApi(page, await createUser('restart-replay'))
    const documentId = await createSheetThroughApi(page)
    const current = await savedContent(page, documentId)
    const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
    const sheetId = current.snapshot.sheetOrder[0] ?? ''
    const snapshot = { ...current.snapshot, sheets: { ...current.snapshot.sheets, [sheetId]: { ...current.snapshot.sheets[sheetId], cellData: { 0: { 0: { v: '回包丢了' } } } } } }
    const body = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'))
    const query = new URLSearchParams({ baseRevision: String(current.revision), requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
    const save = async (): Promise<unknown> => {
      const response = await page.request.put(`/api/documents/${documentId}/content?${query.toString()}`, {
        data: body,
        headers: { 'content-type': 'application/gzip', 'origin': e2eOrigin(), 'x-csrf-token': csrfToken },
      })
      expect(response.status(), await response.text()).toBe(200)
      return response.json()
    }

    const committed = await save()
    await restartApi(request)
    expect(await save()).toEqual(committed)
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(current.revision + 1)
    expect(cellOf(saved.snapshot, 'A1')?.v).toBe('回包丢了')
    const revisions = await withDatabase(async client => (await client.query<{ revision: number }>('SELECT revision FROM document_revisions WHERE request_id = $1', [query.get('requestId')])).rows)
    expect(revisions).toEqual([{ revision: current.revision + 1 }])
  })
})
