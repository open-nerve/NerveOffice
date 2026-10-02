// 分享的写入先判断文档、再看被授权人（M2-P5 设计 §3.2、§3.4(3) 第 1 步；M2-P5 审查 A 的建议 1，回归用例 R1 移进仓库）：
// 没有分享权限的人（空间里的编辑者、查看者、只凭授权的人）设置授权时，403 排在"给自己 400""被授权人不存在或已停用 409"之前，
// 而且被拒绝之前不取被授权人的账户行。sharing.test.ts 与权限矩阵只拿一个有效的、别人的账户当被授权人：把不加锁的判断放宽成
// "能读就行"（分享的权限只在锁下判断，审查 A 的变异 M25），集成测试照样全绿，只有用假仓储的单元测试挡得住。这里在接口一层钉住先后。
// "不取账户行"靠测试持着那一行来核对，同一次持锁里另有阳性对照（M2-P5 复验 G2）：能分享的人给同一个人设置，要等那一行、回 503——
// 证明持锁确实持住了请求要取的那一行，持错了行时对照不再是 503。应用等锁 300 毫秒就放弃（与 api/busy-after-commit.test.ts 相同），
// 对照不必等满默认的 5 秒；取了那一行的请求同样等 300 毫秒之后回 503，与立即的 403 照样分得清。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { grantsOn, setGrant } from '../support/grants.ts'
import { whileHolding } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let sessions: Record<'editor' | 'viewer' | 'grantee', { readonly account: TestAccount, readonly session: LoggedIn }>
/** 空间管理员 amy 的登录：持锁的用例里做阳性对照 */
let amySession: LoggedIn

const NOT_ADMIN = { status: 403, code: 'PERMISSION_DENIED', message: '只有空间管理员能分享这份文档' }
const GRANT_ONLY = { status: 403, code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能再分享给别人' }

beforeAll(async () => {
  database = await createTestDatabase()
  // 等锁 300 毫秒就放弃：持锁的用例里阳性对照不必等满 5 秒（见文件头）
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_DATABASE_LOCK_TIMEOUT_MS: '300' } })
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy' })
  amySession = await login(app.baseUrl, amy.username, amy.password)
  const entries = await Promise.all((['editor', 'viewer', 'grantee'] as const).map(async (name) => {
    const account = await createAccount(database, { username: `order-${name}` })
    return [name, { account, session: await login(app.baseUrl, account.username, account.password) }] as const
  }))
  sessions = Object.fromEntries(entries) as typeof sessions
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function errorOf(response: Response): Promise<{ status: number, code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { status: response.status, code, message }
}

async function share(user: LoggedIn, documentId: string, userId: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${documentId}/grants/${userId}`, { method: 'PUT', body: { role: 'editor' } })
}

describe('US-M2-14 没有分享权限的人：403 排在 400、409 之前，被拒绝之前不取被授权人的账户行', () => {
  it('编辑者、查看者、只凭授权的人给自己、给不存在的人、给停用的人设置授权：一律 403（各自的说明），什么也不写', async () => {
    const spaceId = await createTeamSpace(database, {
      name: '先后',
      createdBy: root.id,
      members: { [amy.id]: 'admin', [sessions.editor.account.id]: 'editor', [sessions.viewer.account.id]: 'viewer' },
    })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '先后' })
    await setGrant(database, { documentId: document.id, userId: sessions.grantee.account.id, role: 'editor', grantedBy: amy.id })
    const leaver = await createPassiveAccount(database, { username: 'order-leaver', status: 'disabled' })
    // 前提：三个人都看得到这份文档（403 而不是 404 才有意义）
    for (const { session } of Object.values(sessions))
      expect((await asUser(app.baseUrl, session, `/api/documents/${document.id}`)).status).toBe(200)

    const cases = [[sessions.editor, NOT_ADMIN], [sessions.viewer, NOT_ADMIN], [sessions.grantee, GRANT_ONLY]] as const
    for (const [{ account, session }, denied] of cases) {
      for (const target of [account.id, randomUUID(), leaver.id])
        expect(await errorOf(await share(session, document.id, target)), `${account.username} → ${target}`).toEqual(denied)
    }
    expect((await grantsOn(database, [document.id])).map(grant => grant.userId)).toEqual([sessions.grantee.account.id])
  })

  it('查看者给别人设置授权：别的事务锁着被授权人的账户行，照样立即 403——被拒绝之前不碰那一行；同一次持锁里空间管理员给同一个人设置，要等那一行、回 503', async () => {
    const colleague = await createAccount(database, { username: 'order-colleague' })
    const spaceId = await createTeamSpace(database, { name: '先后 锁', createdBy: root.id, members: { [amy.id]: 'admin', [sessions.viewer.account.id]: 'viewer' } })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '先后 锁' })
    // 测试持着那一行直到两个请求都结束：请求要是去取被授权人的账户行（FOR SHARE），就会等满应用等锁的时限、回 503，而不是 403。
    // 持的是 FOR NO KEY UPDATE：与取账户行的 FOR SHARE 冲突，与外键检查的 FOR KEY SHARE 不冲突。下面的对照写授权时要对设置人（amy）
    // 的账户行做外键检查：持的要是 FOR UPDATE，持错成 amy 的行时对照照样被挡住、回 503，分不出持的是不是被授权人那一行（第二批修复的变异）
    const { denied, control } = await whileHolding(
      database,
      async client => client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [colleague.id]),
      async () => {
        const denied = await share(sessions.viewer.session, document.id, colleague.id)
        // 阳性对照（M2-P5 复验 G2）：空间管理员能分享，照常往下走、要持住被授权人的账户行（FOR SHARE），等满时限回 503。
        // 这证明持锁确实持住了请求要取的那一行：持错了行（别人的账户，包括对照自己的），对照就会成功，上面的 403 也就证明不了"不碰那一行"
        const control = await share(amySession, document.id, colleague.id)
        return { denied, control }
      },
    )
    expect(await errorOf(denied)).toEqual(NOT_ADMIN)
    expect(control.status, await control.clone().text()).toBe(503)
    expect((await errorOf(control)).code).toBe('SERVICE_UNAVAILABLE')
    expect(await grantsOn(database, [document.id])).toEqual([])
    // 放开之后同一个对照照常成功：503 只是因为那一行被持着，不是对照本身有别的问题
    expect((await share(amySession, document.id, colleague.id)).status).toBe(200)
  })
})
