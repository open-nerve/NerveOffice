// 打开自检失败的上报（M3-P4 设计 §3.13，US-M3-15）：POST /api/documents/{id}/open-check-failures。
// 能读就能报（权限矩阵在 permissions/open-check-matrix.test.ts，看不到与不存在在 hidden-missing-parity.test.ts）；这里核对行为：
// 204 没有正文；采纳的记一条 warn（稳定的 event，服务端补上当前修订号与文档的档案），日志里没有快照、data 与异常的 message；
// 请求体严格解析；进程内去重（文档、修订号、失败、构建）与按账户限量（每 10 分钟 20 条，超出的照样 204，每个窗口记一条"上报过多"）；
// 不写库、不记审计，判断在只读快照里
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LogEntry } from '../support/log-capture.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { CSRF_TOKEN_HEADER, errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { CLIENT_BUILD } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { setGrant } from '../support/grants.ts'
import { openCheckPath, openCheckReport, postOpenCheckReport } from '../support/open-check.ts'
import { asUser, login } from '../support/session-client.ts'
import { captureStatements } from '../support/statement-capture.ts'

let database: TestDatabase
let app: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 每个用例一个新账户、一份新文档：去重与限量的状态互不影响 */
async function fresh(name: string): Promise<{ readonly account: TestAccount, readonly session: LoggedIn, readonly documentId: string }> {
  const account = await createAccount(database, { username: `open-check-${name}` })
  const session = await login(app.baseUrl, account.username, account.password)
  const { id } = await seedDocument(database, { spaceId: account.personalSpaceId, createdBy: account.id, title: `打开自检 ${name}` })
  return { account, session, documentId: id }
}

/** 这份文档的 open-check-failed 日志 */
function failureLogs(documentId: string): LogEntry[] {
  return app.logs.entries().filter(entry => entry.event === 'open-check-failed' && entry.documentId === documentId)
}

function throttledLogs(userId: string): LogEntry[] {
  return app.logs.entries().filter(entry => entry.event === 'open-check-reports-throttled' && entry.userId === userId)
}

/** 采纳的日志里应有的业务字段（日志的公共字段之外的全部） */
const LOGGED_FIELDS = ['event', 'documentId', 'revision', 'currentRevision', 'documentProfile', 'access', 'trigger', 'failures', 'clientBuild', 'univerVersion', 'profile', 'formatVersion']
/** 每条日志都有的公共字段：pino 的级别、时间、进程、主机，请求日志带的请求标识与用户，模块，说明 */
const COMMON_FIELDS = ['level', 'time', 'pid', 'hostname', 'requestId', 'userId', 'module', 'msg']

describe('US-M3-15 打开自检失败的上报：204，记一条 warn', () => {
  it('US-M3-15 能读就能报：204 没有正文；记一条 warn，带稳定的 event 与解析出的字段，服务端补上当前修订号与文档的档案；不多不少', async () => {
    const { account, session, documentId } = await fresh('logged')
    const response = await postOpenCheckReport(app.baseUrl, session, documentId)
    expect(response.status, await response.clone().text()).toBe(204)
    expect(await response.text()).toBe('')
    const [entry, ...rest] = failureLogs(documentId)
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      level: 'warn',
      userId: account.id,
      module: 'documents',
      event: 'open-check-failed',
      documentId,
      revision: 1,
      currentRevision: 1,
      documentProfile: 'sheet@1',
      access: 'read',
      trigger: 'open',
      failures: [{ kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' }, { kind: 'resource-emptied', resource: 'SHEET_FILTER_PLUGIN' }],
      clientBuild: CLIENT_BUILD,
      univerVersion: '1.0.1',
      profile: 'sheet@1',
      formatVersion: 1,
    })
    expect(Object.keys(entry ?? {}).filter(key => !COMMON_FIELDS.includes(key)).sort()).toEqual([...LOGGED_FIELDS].sort())
  })

  it('US-M3-15 报的修订号比当前的新（或旧）：照记，带上当前修订号，供运维判断报的是不是这一版；失败清单按规范形式（去重、排序）记下', async () => {
    const { session, documentId } = await fresh('revision')
    const failures = [{ kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN' }, { kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' }, { kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN' }]
    expect((await postOpenCheckReport(app.baseUrl, session, documentId, openCheckReport({ revision: 5, access: 'edit', trigger: 'enter', failures }))).status).toBe(204)
    expect(failureLogs(documentId)).toEqual([expect.objectContaining({
      revision: 5,
      currentRevision: 1,
      access: 'edit',
      trigger: 'enter',
      failures: [{ kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' }, { kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN' }],
    })])
  })

  it('US-M3-15 不写库、不记审计：判断在一个只读快照里（REPEATABLE READ READ ONLY），没有 INSERT、UPDATE、DELETE', async () => {
    const { session, documentId } = await fresh('read-only')
    const capture = captureStatements(database.name)
    try {
      const { result, statements } = await capture.during(async () => postOpenCheckReport(app.baseUrl, session, documentId))
      expect(result.status).toBe(204)
      const lowered = statements.map(statement => statement.toLowerCase())
      expect(lowered).toContain('begin isolation level repeatable read read only')
      expect(lowered.filter(statement => /^(?:insert|update|delete)\b/.test(statement) && !statement.includes('auth_sessions'))).toEqual([])
    }
    finally {
      capture.restore()
    }
    const audits = await database.query(async client => (await client.query<{ count: string }>('SELECT count(*) FROM audit_events WHERE target_id = $1', [documentId])).rows[0]?.count)
    expect(audits).toBe('0')
  })
})

describe('US-M3-15 请求体严格解析：不合法的 400，什么也不记', () => {
  /**
   * 请求体里夹带的内容（日志里不该出现它）：原来只是"机密"两个字，M3-P6 起应用自己的日志里有"本机密钥"（启动自检），
   * 两个字的标记会撞上，换成不会出现在应用日志里的写法
   */
  const SECRET = '机密正文'
  /** 不合法的请求到不了去重与限量：全部用例共用一个人、一份文档 */
  let shared: Awaited<ReturnType<typeof fresh>>

  beforeAll(async () => {
    shared = await fresh('invalid')
  })

  it.each([
    ['多出的字段：异常的 message', { message: `Unexpected token '机', "{"note": ${SECRET}}" is not valid JSON` }],
    ['多出的字段：快照', { snapshot: `{"id":"${SECRET}"}` }],
    ['失败里多出 data', { failures: [{ kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN', data: `{"s1":"${SECRET}"}` }] }],
    ['构造器名带着 message', { failures: [{ kind: 'parse-threw', resource: 'SHEET_NOTE_PLUGIN', error: `SyntaxError: ${SECRET}` }] }],
    ['不认识的种类', { failures: [{ kind: 'resource-changed', resource: 'SHEET_NOTE_PLUGIN' }] }],
    ['资源名不合写法', { failures: [{ kind: 'resource-missing', resource: SECRET }] }],
    ['不是抛错的种类带构造器名', { failures: [{ kind: 'resource-missing', resource: 'SHEET_NOTE_PLUGIN', error: 'TypeError' }] }],
    ['失败清单为空', { failures: [] }],
    ['失败清单超过 32 项', { failures: Array.from({ length: 33 }).fill({ kind: 'resource-missing', resource: 'SHEET_NOTE_PLUGIN' }) }],
    ['不认识的打开方式', { access: 'write' }],
    ['不认识的起因', { trigger: 'save' }],
    ['修订号为 0', { revision: 0 }],
    ['缺页面的构建', { clientBuild: undefined }],
    ['缺格式版本', { formatVersion: undefined }],
  ])('%s', async (_case, overrides) => {
    const { session, documentId } = shared
    const response = await postOpenCheckReport(app.baseUrl, session, documentId, openCheckReport(overrides))
    expect(response.status, await response.clone().text()).toBe(400)
    expect(parseExact(errorResponseSchema, await response.json()).error.code).toBe('REQUEST_INVALID')
    expect(failureLogs(documentId)).toEqual([])
    expect(app.logs.text()).not.toContain(SECRET)
  })

  it('没有 CSRF 令牌：403（全局管线照常管它，后台请求的标记只影响顺延）', async () => {
    const { session, documentId } = await fresh('csrf')
    const response = await asUser(app.baseUrl, session, openCheckPath(documentId), { method: 'POST', body: openCheckReport(), headers: { [CSRF_TOKEN_HEADER]: undefined } })
    expect([response.status, parseExact(errorResponseSchema, await response.json()).error.code]).toEqual([403, 'CSRF_TOKEN_INVALID'])
    expect(failureLogs(documentId)).toEqual([])
  })
})

describe('US-M3-15 进程内去重（文档、修订号、失败、构建；10 分钟）', () => {
  it('同样的上报再来（不论谁报、打开方式与起因是什么）：照样 204，只记第一次；修订号、构建或失败不同的另记一条', async () => {
    const { account, session, documentId } = await fresh('dedupe')
    const viewer = await createAccount(database, { username: 'open-check-dedupe-viewer' })
    const viewerSession = await login(app.baseUrl, viewer.username, viewer.password)
    await setGrant(database, { documentId, userId: viewer.id, role: 'viewer', grantedBy: account.id })
    const statuses = [
      await postOpenCheckReport(app.baseUrl, session, documentId),
      await postOpenCheckReport(app.baseUrl, session, documentId),
      await postOpenCheckReport(app.baseUrl, viewerSession, documentId, openCheckReport({ access: 'edit', trigger: 'refresh' })),
    ].map(response => response.status)
    expect(statuses).toEqual([204, 204, 204])
    expect(failureLogs(documentId)).toHaveLength(1)

    expect((await postOpenCheckReport(app.baseUrl, session, documentId, openCheckReport({ revision: 2 }))).status).toBe(204)
    expect((await postOpenCheckReport(app.baseUrl, session, documentId, openCheckReport({ clientBuild: '0.1.0+other' }))).status).toBe(204)
    expect((await postOpenCheckReport(app.baseUrl, session, documentId, openCheckReport({ failures: [{ kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' }] }))).status).toBe(204)
    const logged = failureLogs(documentId).map(entry => [entry.revision, entry.clientBuild, (entry.failures as unknown[]).length])
    expect(logged).toEqual([[1, CLIENT_BUILD, 2], [2, CLIENT_BUILD, 2], [1, '0.1.0+other', 2], [1, CLIENT_BUILD, 1]])
  })
})

describe('US-M3-15 先判断能不能读，再去重与限量（审查 B4）', () => {
  it('看不到这份文档的人报（404，不记）：不占用去重键——能读的人报同样的内容照样记一条；也不占用报的人自己的配额', async () => {
    const { session, documentId } = await fresh('read-first')
    const outsider = await fresh('read-first-outsider')
    // 外人知道文档 id、修订号、构建与失败签名：报 21 次（超过每个账户的 20 条），一律 404，什么也不记
    for (let revision = 1; revision <= 21; revision += 1)
      expect((await postOpenCheckReport(app.baseUrl, outsider.session, documentId, openCheckReport({ revision }))).status, `第 ${revision} 次`).toBe(404)
    expect(failureLogs(documentId)).toEqual([])
    // 能读的人报同样的内容（修订号 1）：照样记下
    expect((await postOpenCheckReport(app.baseUrl, session, documentId)).status).toBe(204)
    expect(failureLogs(documentId)).toHaveLength(1)
    // 外人对自己的文档报：配额没有被那 21 次 404 用掉
    expect((await postOpenCheckReport(app.baseUrl, outsider.session, outsider.documentId)).status).toBe(204)
    expect(failureLogs(outsider.documentId)).toHaveLength(1)
    expect(throttledLogs(outsider.account.id)).toEqual([])
  })
})

describe('US-M3-15 按账户限量（每 10 分钟 20 条被采纳）', () => {
  it('第 21 条起照样 204、不记；这个窗口只记一条"上报过多"；别的账户照常记', async () => {
    const { account, session, documentId } = await fresh('limit')
    for (let revision = 1; revision <= 22; revision += 1) {
      const response = await postOpenCheckReport(app.baseUrl, session, documentId, openCheckReport({ revision }))
      expect(response.status, `第 ${revision} 条`).toBe(204)
    }
    expect(failureLogs(documentId).map(entry => entry.revision)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    expect(throttledLogs(account.id)).toEqual([expect.objectContaining({ level: 'warn', limit: 20, windowMinutes: 10 })])

    const other = await fresh('limit-other')
    expect((await postOpenCheckReport(app.baseUrl, other.session, other.documentId)).status).toBe(204)
    expect(failureLogs(other.documentId)).toHaveLength(1)
    expect(throttledLogs(other.account.id)).toEqual([])
  })
})
