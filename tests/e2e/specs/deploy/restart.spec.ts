// API 重启后已确认的数据不丢（US-M1-10，A09 的 API 重启部分，P5 设计 §3.6）：强制结束后端（SIGKILL）再启动。
// - 已确认的保存完整；
// - 保存进行中被打断：没有提交；页面再保存一次沿用同一个 requestId，修订号只加一；
// - 已经提交、回包丢了：重试返回原来的结果，不重复写入。
// 单独的 Playwright 项目 restart：全部浏览器项目跑完之后才执行，强制结束后端不会打断别的用例（playwright.config.ts）。
import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { acquiredEditLeaseSchema, EDIT_LEASE_HEADER } from '@nerve-office/contracts'
import { restartApi } from '../../support/api-process.ts'
import { clientFormatQuery, CURRENT_CLIENT } from '../../support/client-format.ts'
import { createUser, withDatabase } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, disconnectTab, isSaveRequest, openAndEnterEditing, saveAndWait, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

/**
 * 后端连接数据库时的应用名：与 apps/api 的 APPLICATION_NAME（modules/database/pool.ts）相同，那边改名时这里要同步。
 * E2E 不依赖后端的包，所以照写一份、不引用（M2 Codex 评审第二轮复验的一般 5）。没有同步时，下面的轮询认不出后端在等锁的会话，
 * 15 秒后明显失败，不会悄悄通过
 */
const API_APPLICATION_NAME = 'nerve-office-api'

/** 后端在等锁的会话（测试直连数据库锁住内容行时，后端的保存事务停在这里）的进程号 */
async function apiSessionsWaitingForLock(): Promise<number[]> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = \'Lock\'',
      [API_APPLICATION_NAME],
    )
    return rows.map(row => row.pid)
  })
}

/** 这些数据库会话还在的个数 */
async function sessionsAlive(pids: readonly number[]): Promise<number> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ count: string }>('SELECT count(*) AS count FROM pg_stat_activity WHERE pid = ANY($1)', [[...pids]])
    return Number(rows[0]?.count)
  })
}

/** 按 requestId 查到的修订记录数 */
async function revisionsOf(requestId: string): Promise<number> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ count: string }>('SELECT count(*) AS count FROM document_revisions WHERE request_id = $1', [requestId])
    return Number(rows[0]?.count)
  })
}

/** 这个页面发出的保存请求的 requestId 与收到的回答（requestId 与状态码），按先后 */
function recordSaveRequests(page: Page): { readonly sent: string[], readonly answered: { requestId: string, status: number }[] } {
  const sent: string[] = []
  const answered: { requestId: string, status: number }[] = []
  page.on('request', (request) => {
    if (isSaveRequest(request))
      sent.push(new URL(request.url()).searchParams.get('requestId') ?? '')
  })
  page.on('response', (response) => {
    if (isSaveRequest(response.request()))
      answered.push({ requestId: new URL(response.url()).searchParams.get('requestId') ?? '', status: response.status() })
  })
  return { sent, answered }
}

// 三条共用一个后端：同一个文件里的用例按顺序在一个工作进程里执行（这个项目没有开 fullyParallel）。
// 不用 serial：一条失败不连带跳过后面的
test.describe('US-M1-10 API 重启后已确认的数据不丢', () => {
  test('已确认的保存：强制结束后端再启动，重新打开时内容与修订号都在', async ({ page, request }) => {
    await loginThroughApi(page, await createUser('restart-confirmed'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', '重启之前已确认')
    await saveAndWait(page)
    const confirmed = await savedContent(page, documentId)

    await restartApi(request)
    await openAndEnterEditing(page, documentId)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    const reopened = await savedContent(page, documentId)
    expect(reopened.revision).toBe(confirmed.revision)
    expect(reopened.text).toBe(confirmed.text)
    expect(cellOf(reopened.snapshot, 'A1')?.v).toBe('重启之前已确认')
  })

  test('保存进行中被打断：没有提交；页面再保存一次沿用同一个 requestId，修订号只加一', async ({ page, request }) => {
    await loginThroughApi(page, await createUser('restart-interrupted'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const before = await savedContent(page, documentId)
    const saves = recordSaveRequests(page)
    await typeInCell(page, 'A1', '被打断的保存')

    // 测试直连数据库锁住内容行：后端的保存事务已经写了修订记录、推进了修订号，停在替换内容上等锁（审查 B1），
    // 这时强制结束后端。释放锁之后，等被结束的后端的会话消失（拿到锁、发现连接断了、回滚）
    // 结果未知的失败会自动重试（M3-P4 设计 §3.8）：测试构建暂停了定时的上传，生产构建里 2 秒之后原样重发。被打断之后断开这一页的保存
    // （与心跳），核对完"没有提交"再恢复：之间的重试到不了服务端
    let waiting: number[] = []
    let offline: Awaited<ReturnType<typeof disconnectTab>> | undefined
    await withDatabase(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('SELECT 1 FROM document_contents WHERE document_id = $1 FOR UPDATE', [documentId])
        await saveButton(page).click()
        await expect.poll(async () => {
          waiting = await apiSessionsWaitingForLock()
          return waiting.length
        }, { timeout: 15_000 }).toBeGreaterThan(0)
        offline = await disconnectTab(page)
        await restartApi(request)
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
    await expect.poll(async () => sessionsAlive(waiting), { timeout: 15_000 }).toBe(0)

    // 要么完整提交、要么没有提交：修订号、修订记录与内容都没有变
    await expect(saveStatus(page)).toHaveText('保存失败，稍后自动重试')
    const afterInterruption = await savedContent(page, documentId)
    expect(afterInterruption.revision).toBe(before.revision)
    expect(afterInterruption.text).toBe(before.text)
    const interrupted = saves.sent[0] ?? ''
    expect(await revisionsOf(interrupted)).toBe(0)

    // 恢复之后再保存（生产构建里可能是自动保存的重试先发出）：第一次成功的就是原样重发的那一个 requestId，修订号只加一。
    // 之前的回答只有被打断的那一次（经反向代理时它得到 502，直连时连接断开、没有回答）
    await offline?.reconnect()
    await saveAndWait(page)
    expect(saves.sent.length).toBeGreaterThanOrEqual(2)
    const firstSaved = saves.answered.findIndex(answer => answer.status === 200)
    expect(saves.answered[firstSaved]?.requestId).toBe(interrupted)
    expect(saves.answered.slice(0, firstSaved).every(answer => answer.requestId === interrupted && answer.status >= 500)).toBe(true)
    expect(await revisionsOf(interrupted)).toBe(1)
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
    // M3-P1 起保存要求编辑租约：先经接口申请（这个标签页），保存带上令牌与代次。重启之后的重发是重放，在租约之前判断（US-M3-13）。
    // M3-P3 起申请与保存都照现在的页面带上构建与数据格式（缺了按过旧）
    const clientInstanceId = randomUUID()
    const acquired = await page.request.post(`/api/documents/${documentId}/edit-lease`, {
      data: { clientInstanceId, ...CURRENT_CLIENT },
      headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken },
    })
    expect(acquired.status(), await acquired.text()).toBe(201)
    const lease = acquiredEditLeaseSchema.parse(await acquired.json())
    const query = new URLSearchParams({ baseRevision: String(current.revision), requestId: randomUUID(), clientInstanceId, localSeq: '1', writeEpoch: String(lease.writeEpoch), formulasPending: 'false', ...clientFormatQuery() })
    const save = async (): Promise<unknown> => {
      const response = await page.request.put(`/api/documents/${documentId}/content?${query.toString()}`, {
        data: body,
        headers: { 'content-type': 'application/gzip', 'origin': e2eOrigin(), 'x-csrf-token': csrfToken, [EDIT_LEASE_HEADER]: lease.token },
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
