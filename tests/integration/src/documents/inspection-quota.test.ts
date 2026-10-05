// 快照检查池按账户限份数（M3-P3 审查 A2）：快照的检查在判断访问之前（与文档无关），整个池子所有人共用。一个看不到任何文档的账户
// 并发提交重的快照（目标是随机的 id），只占得到自己的份数（INSPECTIONS_PER_ACCOUNT：执行中与排队中合计），别人的保存照常排进来、
// 得到 200；他多出来的那几份立即 503（带 Retry-After，与池子繁忙同一个回答），记一条 warn。
// 应用配成 1 个子进程、排队 2 个（小，好构造）：没有按账户的上限时，他的 4 份就占满了子进程与排队，别人的保存立即 503（审查探针的情形）。
// 交错：他的 4 份同时发出，等到其中一份已经得到 503（池子里该占的都占上了：有上限时是他的份数满了，没有上限时是排队满了）再发别人的保存——
// 一份重快照的检查要几百毫秒，别人的请求这时到达
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { saveContentResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { saveContent, strayLease } from '../support/edit-leases.ts'
import { login } from '../support/session-client.ts'
import { waitFor } from '../support/wait.ts'

let database: TestDatabase
let app: TestApp
let amy: TestAccount
let mallory: TestAccount
let amySession: LoggedIn
let mallorySession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_SNAPSHOT_INSPECTION_PROCESSES: '1', NERVE_SNAPSHOT_INSPECTION_QUEUE_MAX: '2' } })
  amy = await createAccount(database, { username: 'quota-amy' })
  mallory = await createAccount(database, { username: 'quota-mallory' })
  amySession = await login(app.baseUrl, amy.username, amy.password)
  mallorySession = await login(app.baseUrl, mallory.username, mallory.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

const MIB = 1024 * 1024

/** 重的快照（审查探针的形状）：5 MiB 之内几十万个各不相同的小对象，过得了解析之前的数量上限，检查一份要几百毫秒 */
function heavy(): Buffer {
  const parts: string[] = []
  let size = 0
  for (let index = 0; ; index += 1) {
    const part = `{"${index.toString(36)}":0}`
    if (size + part.length + 1 > 5 * MIB - 400)
      break
    parts.push(part)
    size += part.length + 1
  }
  return zlib.gzipSync(Buffer.from(`{"id":"u","sheetOrder":[],"sheets":{},"resources":[],"a":[${parts.join(',')}]}`, 'utf8'))
}

describe('快照检查池按账户限份数（M3-P3 审查 A2）', () => {
  it('一个看不到任何文档的人并发提交重的快照：只占得到自己的份数，多出来的对他 503（带 Retry-After）；别人的保存照常排进来、得到 200', async () => {
    const document = await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '正常保存的' })
    const sheet = SHEET_TEMPLATE.sheets['sheet-1']
    const legit = zlib.gzipSync(Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: 1 } } } } } }), 'utf8'))
    const body = heavy()
    const settled: { status: number, retryAfter: string | null }[] = []
    const attacks = Array.from({ length: 4 }, async () => {
      const response = await saveContent(app.baseUrl, mallorySession, randomUUID(), body, { baseRevision: 1, lease: strayLease() })
      await response.arrayBuffer()
      const outcome = { status: response.status, retryAfter: response.headers.get('retry-after') }
      settled.push(outcome)
      return outcome
    })
    // 池子里该占的都占上了：他的一份已经得到 503
    await waitFor(() => settled.some(outcome => outcome.status === 503), '他的一份得到 503', 20_000)

    const response = await saveContent(app.baseUrl, amySession, document.id, legit, { baseRevision: 1 })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(parseExact(saveContentResponseSchema, await response.json())).toMatchObject({ revision: 2, unchanged: false })

    const outcomes = await Promise.all(attacks)
    // 进了池子的检查完了也只是 404（目标是随机的 id）；多出来的 503 带 Retry-After（排队等待的时限，默认 10 秒）
    expect(outcomes.every(outcome => outcome.status === 404 || outcome.status === 503), JSON.stringify(outcomes)).toBe(true)
    expect(outcomes.filter(outcome => outcome.status === 503).every(outcome => outcome.retryAfter === '10')).toBe(true)
    expect(app.logs.entries().some(entry => typeof entry.msg === 'string' && entry.msg.includes('份数已满') && entry.userId === mallory.id)).toBe(true)
  })
})
