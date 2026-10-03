// 每一个登录之后的 GET 接口都在一个只读快照里判断权限、读数据（M2 Codex 评审 CX1）：结构性的核对，与 permissions/read-snapshot.test.ts
// 的确定交错互补——那里证明快照挡得住撤权之后的数据，这里证明每个读接口都走快照、只有一个快照、快照之外不读数据。
// 接口从运行中的应用的路由表列出（support/routes.ts），不手写接口清单：新加的 GET 接口不在下面的请求表里，或者不走快照，这里就失败。
// 对每个接口用能成功的参数发一次请求（2xx），记下应用发出的语句与发出它的连接（support/statement-capture.ts），断言：
// - 快照之前只有会话守卫的语句（与"只走守卫"的请求逐条相同：按摘要查会话、按 id 查账户，都在连接池上）；
// - 守卫之后恰好开了一个快照：BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY，开场核对在最前——第一条按 id 查守卫认证过的那条会话
//   （M2 Codex 评审复验的建议 3），第二条按 id 查这个人的账户，参数是本人的会话与账户；
//   之后的语句全部在同一个连接上，以 COMMIT 结束，COMMIT 之后再没有语句——没有语句在快照之外读数据。
//   这里每个接口只发一组参数，走不到的分支另由连接池兜住：快照进行中，连接池上的查询一律报错（apps/api 的 pool.ts，复验的必须修 1）；
// - 不走快照的 GET 接口只有 EXEMPT 写明的几个，各有原因：都是公开的接口（没有登录，没有要在快照里复核的身份与权限）。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { Route } from '../support/routes.ts'
import type { LoggedIn } from '../support/session-client.ts'
import type { CapturedQuery, StatementCapture } from '../support/statement-capture.ts'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { setGrants } from '../support/grants.ts'
import { routesOf } from '../support/routes.ts'
import { asUser, login, SESSION_COOKIE } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'
import { captureStatements } from '../support/statement-capture.ts'

/**
 * 不走只读快照的 GET 接口与原因。都是公开的接口（@Public()，api/routes.test.ts 的公开清单）：没有登录，会话守卫不记身份，
 * 也就没有要在快照里复核的事实；它们读的也不是哪个人有权看的数据
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'GET /api/health/live': '存活探针：公开，不访问数据库',
  'GET /api/health/ready': '就绪探针：公开，只读迁移的记录（库结构版本）与连接是否可用，不读任何人的数据；结果跨请求缓存一秒，不属于哪一个请求',
}

/** 只读快照的开始（drizzle 发出的写法） */
const SNAPSHOT_BEGIN = 'begin isolation level repeatable read read only'

interface World {
  /** 普通成员：个人空间里有文档、文件夹、回收站里的文档；是团队空间的成员；别人分享给他一份文档 */
  readonly amy: TestAccount
  readonly root: TestAccount
  /** 停用的账户，个人空间里有一份文档（管理界面的转移页） */
  readonly leaver: string
  readonly document: string
  readonly team: string
}

/** 一个接口的请求：谁发（各用一条新登录的会话：会话不会因为超过 1 分钟而在守卫里多一条顺延的语句）、路径 */
interface Probe {
  readonly who: 'amy' | 'root'
  readonly path: string
}

/** 每个登录之后的 GET 接口用能成功的参数发的请求。新加的 GET 接口要在这里登记一个，并且走只读快照 */
const PROBES: Readonly<Record<string, (w: World) => Probe>> = {
  'GET /api/admin/audit-events': () => ({ who: 'root', path: '/api/admin/audit-events' }),
  'GET /api/admin/invitations': () => ({ who: 'root', path: '/api/admin/invitations' }),
  'GET /api/admin/spaces': () => ({ who: 'root', path: '/api/admin/spaces' }),
  'GET /api/admin/users': () => ({ who: 'root', path: '/api/admin/users' }),
  'GET /api/admin/users/:id': w => ({ who: 'root', path: `/api/admin/users/${w.amy.id}` }),
  'GET /api/admin/users/:id/documents': w => ({ who: 'root', path: `/api/admin/users/${w.leaver}/documents` }),
  'GET /api/auth/session': () => ({ who: 'amy', path: '/api/auth/session' }),
  'GET /api/documents': w => ({ who: 'amy', path: `/api/documents?spaceId=${w.amy.personalSpaceId}` }),
  'GET /api/documents/:id': w => ({ who: 'amy', path: `/api/documents/${w.document}` }),
  'GET /api/documents/:id/content': w => ({ who: 'amy', path: `/api/documents/${w.document}/content` }),
  'GET /api/documents/:id/grants': w => ({ who: 'amy', path: `/api/documents/${w.document}/grants` }),
  'GET /api/folders': w => ({ who: 'amy', path: `/api/folders?spaceId=${w.amy.personalSpaceId}` }),
  'GET /api/search': () => ({ who: 'amy', path: `/api/search?query=${encodeURIComponent('快照')}` }),
  'GET /api/shared': () => ({ who: 'amy', path: '/api/shared' }),
  'GET /api/spaces': () => ({ who: 'amy', path: '/api/spaces' }),
  'GET /api/spaces/:id': w => ({ who: 'amy', path: `/api/spaces/${w.amy.personalSpaceId}` }),
  'GET /api/spaces/:id/members': w => ({ who: 'amy', path: `/api/spaces/${w.team}/members` }),
  'GET /api/trash': w => ({ who: 'amy', path: `/api/trash?spaceId=${w.amy.personalSpaceId}` }),
  'GET /api/users': () => ({ who: 'amy', path: `/api/users?query=${encodeURIComponent('快照')}` }),
}

let database: TestDatabase
let app: TestApp
let capture: StatementCapture
let routes: Route[]
let w: World

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  const root = await createAccount(database, { username: 'snapshot-root', displayName: '快照 管理员', systemRole: 'admin' })
  const amy = await createAccount(database, { username: 'snapshot-amy', displayName: '快照 艾米' })
  const ben = await createAccount(database, { username: 'snapshot-ben', displayName: '快照 本' })
  const leaver = await createPassiveAccount(database, { username: 'snapshot-leaver', status: 'disabled' })
  await seedDocument(database, { spaceId: leaver.personalSpaceId, createdBy: leaver.id, title: '快照：停用者的' })
  const document = (await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '快照：艾米的' })).id
  const shared = (await seedDocument(database, { spaceId: ben.personalSpaceId, createdBy: ben.id, title: '快照：分享给艾米的' })).id
  const team = await createTeamSpace(database, { name: '快照：团队', createdBy: root.id, members: { [amy.id]: 'viewer', [ben.id]: 'admin' } })
  await setGrants(database, [
    { documentId: shared, userId: amy.id, role: 'viewer', grantedBy: ben.id },
    { documentId: document, userId: ben.id, role: 'editor', grantedBy: amy.id },
  ])
  // 文件夹与回收站里的一份文档：经接口建、删（列表要算回收站的计数与原位置的名称）
  const session = await login(app.baseUrl, amy.username, amy.password)
  const folder = await asUser(app.baseUrl, session, '/api/folders', { method: 'POST', body: { spaceId: amy.personalSpaceId, name: '快照：文件夹', requestId: randomUUID() } })
  expect(folder.status).toBe(201)
  const trashed = (await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '快照：删掉的', folderId: ((await folder.json()) as { id: string }).id })).id
  expect((await asUser(app.baseUrl, session, `/api/documents/${trashed}`, { method: 'DELETE' })).status).toBe(204)
  w = { amy, root, leaver: leaver.id, document, team }
  routes = routesOf(app)
  capture = captureStatements(database.name)
})

afterAll(async () => {
  capture.restore()
  await app.close()
  await database.drop()
})

const nameOf = (route: Route): string => `${route.method} ${route.path}`

/** 新登录一条会话：守卫按摘要查会话、按 id 查账户，会话刚建好，不会再顺延（多一条 UPDATE） */
async function freshSession(who: 'amy' | 'root'): Promise<LoggedIn> {
  const account = who === 'amy' ? w.amy : w.root
  return login(app.baseUrl, account.username, account.password)
}

/** 这条会话在库里的 id：库里只存令牌（Cookie 的值）的 SHA-256 摘要，按摘要找到那一行 */
async function sessionIdOf(session: LoggedIn): Promise<string> {
  const digest = createHash('sha256').update(session.cookie.slice(`${SESSION_COOKIE}=`.length), 'utf8').digest()
  const id = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM auth_sessions WHERE token_hash = $1', [digest])).rows[0]?.id)
  if (id === undefined)
    throw new Error('库里没有这条会话')
  return id
}

/** 发请求并读完响应体，返回状态与期间应用发出的全部语句（带参数与连接） */
async function observe(session: LoggedIn, path: string): Promise<{ status: number, queries: CapturedQuery[] }> {
  const { result, queries } = await capture.during(async () => {
    const response = await asUser(app.baseUrl, session, path)
    await response.arrayBuffer()
    return response.status
  })
  return { status: result, queries }
}

/** 只走会话守卫、不进处理器的请求（成员请求只给系统管理员的接口，守卫拒绝）：守卫自己的语句 */
async function guardStatements(): Promise<CapturedQuery[]> {
  const { status, queries } = await observe(await freshSession('amy'), '/api/admin/users')
  expect(status).toBe(403)
  return queries
}

/** 开场核对要核对的身份：发请求的这个人与守卫认证过的那条会话 */
interface Identity {
  readonly userId: string
  readonly sessionId: string
}

/** 一个请求的语句不符合"守卫之后恰好一个只读快照、开场核对在最前、快照之外不读数据"之处 */
function snapshotProblems(queries: readonly CapturedQuery[], guard: readonly CapturedQuery[], identity: Identity): string[] {
  const begins = queries.flatMap((query, index) => (query.text.toLowerCase() === SNAPSHOT_BEGIN ? [index] : []))
  if (begins.length !== 1)
    return [`应恰好开一个只读快照，实际 ${begins.length} 个；语句：${queries.map(query => query.text).join(' | ')}`]
  const begin = begins[0] ?? 0
  const connection = queries[begin]?.connection
  const problems: string[] = []
  const before = queries.slice(0, begin).map(query => query.text)
  if (before.join('\n') !== guard.map(query => query.text).join('\n'))
    problems.push(`快照之前应只有会话守卫的语句：${before.join(' | ')}`)
  const [sessionCheck, accountCheck] = [queries[begin + 1], queries[begin + 2]]
  if (sessionCheck === undefined || sessionCheck.connection !== connection || !sessionCheck.text.includes('from "auth_sessions"') || !sessionCheck.text.includes('"auth_sessions"."id" = $1') || sessionCheck.values[0] !== identity.sessionId)
    problems.push(`快照的第一条语句应是开场核对的会话（按 id 查守卫认证过的那条会话）：${sessionCheck?.text ?? '（没有）'}`)
  if (accountCheck === undefined || accountCheck.connection !== connection || accountCheck.text !== guard.at(-1)?.text || accountCheck.values[0] !== identity.userId)
    problems.push(`快照的第二条语句应是开场核对的账户（按 id 查这个人的账户）：${accountCheck?.text ?? '（没有）'}`)
  const end = queries.findIndex((query, index) => index > begin && query.connection === connection && query.text.toLowerCase() === 'commit')
  if (end < 0)
    return [...problems, '快照没有以 COMMIT 结束']
  const outside = queries.slice(begin + 1, end).filter(query => query.connection !== connection)
  if (outside.length > 0)
    problems.push(`快照进行中有语句不在快照的连接上：${outside.map(query => query.text).join(' | ')}`)
  if (end !== queries.length - 1)
    problems.push(`COMMIT 之后还有语句：${queries.slice(end + 1).map(query => query.text).join(' | ')}`)
  return problems
}

describe('登录之后的 GET 接口都在一个只读快照里判断权限、读数据（M2 Codex 评审 CX1）', () => {
  it('路由表里的 GET 接口：登录之后的每一个都在请求表里，不在的只有写明原因的公开接口', () => {
    const gets = routes.filter(route => route.method === 'GET').map(nameOf)
    expect(gets.length).toBeGreaterThan(15)
    expect(gets.filter(name => PROBES[name] === undefined).sort(), '新加的 GET 接口要在 PROBES 里登记一个能成功的请求，并走只读快照').toEqual(Object.keys(EXEMPT).sort())
    // 请求表里没有路由表里已经不存在的接口：清单不会过时
    expect(Object.keys(PROBES).filter(name => !gets.includes(name))).toEqual([])
  })

  it('豁免的都是公开的接口：不带会话也不回 401', async () => {
    for (const name of Object.keys(EXEMPT)) {
      const response = await fetch(`${app.baseUrl}${name.split(' ')[1] ?? ''}`)
      await response.arrayBuffer()
      expect(response.status, name).not.toBe(401)
    }
  })

  it('守卫自己的语句：按摘要查会话、按 id 查账户，都在连接池上（快照之前只该有它们）', async () => {
    const guard = await guardStatements()
    expect(guard).toHaveLength(2)
    expect(guard[0]?.text).toContain('"auth_sessions"')
    expect(guard[1]?.text).toContain('from "users"')
    expect(guard.some(query => query.text.toLowerCase().startsWith('begin'))).toBe(false)
  })

  it('每一个登录之后的 GET 接口：守卫之后恰好一个 REPEATABLE READ READ ONLY 快照，开场核对在最前（本人的会话、本人的账户），其余语句都在同一个连接上，COMMIT 之后再没有语句', async () => {
    const guard = await guardStatements()
    const problems: string[] = []
    for (const route of routes.filter(candidate => candidate.method === 'GET' && EXEMPT[nameOf(candidate)] === undefined)) {
      const probe = PROBES[nameOf(route)]?.(w)
      if (probe === undefined)
        continue
      const session = await freshSession(probe.who)
      const { status, queries } = await observe(session, probe.path)
      if (status < 200 || status >= 300) {
        problems.push(`${nameOf(route)}：请求没有成功（${status}），换一个能成功的参数`)
        continue
      }
      const identity = { userId: probe.who === 'amy' ? w.amy.id : w.root.id, sessionId: await sessionIdOf(session) }
      problems.push(...snapshotProblems(queries, guard, identity).map(problem => `${nameOf(route)}：${problem}`))
    }
    expect(problems).toEqual([])
  })
})
