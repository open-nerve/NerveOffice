// 团队空间的名称（M2-P2 设计 §3.2、§3.9）：不区分大小写唯一，由唯一索引兜住并发；
// 创建与改名撞上唯一约束时只回滚到保存点，事务仍可继续（M2-P2 审查 A6）：经测试探针在一个事务里撞名之后再改一次。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { AppError, DatabaseModule, Public, SpacesModule, SpacesService, TransactionRunner } from '@nerve-office/api'
import { errorResponseSchema } from '@nerve-office/contracts'
import { Body, Controller, Module, Post } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

interface ProbeResult {
  /** 第一次（撞名）的结局：错误码，或者 done */
  readonly first: string
  /** 同一个事务里第二次之后的名称 */
  readonly name: string
}

/** 撞名的那一次：接住业务错误，记下错误码；其他错误照常抛出 */
async function outcomeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
    return 'done'
  }
  catch (error) {
    if (error instanceof AppError)
      return error.code
    throw error
  }
}

// 只在测试里存在的接口：不经登录。在一个事务里先撞名、接住 SPACE_NAME_TAKEN，再做一次并提交
@Public()
@Controller('__test/space-names')
class SpaceNamesProbeController {
  constructor(private readonly spaces: SpacesService, private readonly transactions: TransactionRunner) {}

  @Post('create')
  async create(@Body() body: { taken: string, fresh: string, createdBy: string, adminUserId: string }): Promise<ProbeResult> {
    return this.transactions.run(async (transaction) => {
      const team = { createdBy: body.createdBy, adminUserId: body.adminUserId, visibleToAll: false }
      const first = await outcomeOf(this.spaces.createTeamSpace({ ...team, name: body.taken }, transaction))
      const space = await this.spaces.createTeamSpace({ ...team, name: body.fresh }, transaction)
      return { first, name: space.name }
    })
  }

  @Post('rename')
  async rename(@Body() body: { spaceId: string, taken: string, fresh: string }): Promise<ProbeResult> {
    return this.transactions.run(async (transaction) => {
      const space = await this.spaces.lockSpace(body.spaceId, transaction)
      if (space === undefined)
        throw new Error('空间不存在')
      const first = await outcomeOf(this.spaces.rename(space, body.taken, transaction))
      const change = await this.spaces.rename(space, body.fresh, transaction)
      return { first, name: change.space.name }
    })
  }
}

@Module({ imports: [DatabaseModule, SpacesModule], controllers: [SpaceNamesProbeController] })
class SpaceNamesProbeModule {}

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let amySession: LoggedIn
let spaces = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url, additionalModules: [SpaceNamesProbeModule] })
  root = await createAccount(database, { username: 'root', displayName: '管理员', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  amySession = await login(app.baseUrl, 'amy', amy.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 一个新的团队空间：艾米是空间管理员 */
async function teamSpace(name?: string): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: name ?? `名称测试 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin' } })
}

async function probe(path: 'create' | 'rename', body: Record<string, string>): Promise<ProbeResult> {
  const response = await fetch(`${app.baseUrl}/api/__test/space-names/${path}`, {
    method: 'POST',
    headers: { 'origin': TEST_PUBLIC_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return await response.json() as ProbeResult
}

async function namesOf(ids: readonly string[]): Promise<string[]> {
  return database.query(async client => (await client.query<{ name: string }>(
    'SELECT name FROM spaces WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)',
    [ids],
  )).rows.map(row => row.name))
}

describe('团队空间的名称：撞名之后事务仍可继续（保存点）', () => {
  it('创建撞名（不区分大小写）：只回滚到保存点，同一个事务里接着建另一个并提交', async () => {
    await teamSpace('撞名的创建 A')
    const result = await probe('create', { taken: '撞名的创建 a', fresh: '撞名之后新建的', createdBy: root.id, adminUserId: amy.id })
    expect(result).toEqual({ first: 'SPACE_NAME_TAKEN', name: '撞名之后新建的' })
    // 撞名的那一个没有建出来；接着建的那一个连同首个空间管理员一起提交了
    const rows = await database.query(async client => (await client.query<{ name: string, members: number }>(
      'SELECT s.name, (SELECT count(*)::int FROM space_members m WHERE m.space_id = s.id) AS members FROM spaces s WHERE s.name = ANY($1::text[])',
      [['撞名的创建 A', '撞名的创建 a', '撞名之后新建的']],
    )).rows)
    expect(Object.fromEntries(rows.map(row => [row.name, row.members]))).toEqual({ '撞名的创建 A': 1, '撞名之后新建的': 1 })
  })

  it('改名撞名：只回滚到保存点，同一个事务里接着改成另一个名字并提交', async () => {
    await teamSpace('撞名的改名')
    const spaceId = await teamSpace()
    expect(await probe('rename', { spaceId, taken: '撞名的改名', fresh: '改成了别的' })).toEqual({ first: 'SPACE_NAME_TAKEN', name: '改成了别的' })
    expect(await namesOf([spaceId])).toEqual(['改成了别的'])
  })
})

describe('团队空间的名称：并发', () => {
  it('两个空间同时改成同一个名字：唯一索引兜住，后提交的一方 409 SPACE_NAME_TAKEN（两个连接构造的交错）', async () => {
    const [first, second] = [await teamSpace(), await teamSpace()]
    const response = await raceAgainstHeldLock(database, {
      // 另一个事务先把第一个空间改成这个名字、还没提交：第二个空间的改名在唯一索引的这一项上等它结束
      hold: async client => client.query('UPDATE spaces SET name = $2 WHERE id = $1', [first, 'Hot Name']),
      request: async () => asUser(app.baseUrl, amySession, `/api/spaces/${second}/name`, { method: 'PUT', body: { name: 'hot name' } }),
      change: async () => {},
    })
    expect(response.status).toBe(409)
    expect(parseExact(errorResponseSchema, await response.json()).error.code).toBe('SPACE_NAME_TAKEN')
    expect(await namesOf([first, second])).toEqual(['Hot Name', expect.stringMatching(/^名称测试/) as unknown])
  })
})
