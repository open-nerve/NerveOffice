// 团队空间的名称（M2-P2 设计 §3.2、§3.9）：按判重键唯一（看起来一样的名称算同一个名字，M2-P6 复核 B 的 M-1），
// 由唯一索引兜住并发；创建与改名撞上唯一约束时只回滚到保存点，事务仍可继续（M2-P2 审查 A6）：经测试探针在一个事务里撞名之后再改一次。
// 看不见的字符一律写成 \u 转义：源码里直接出现它们，审阅时看不出来。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { AppError, DatabaseModule, Public, SpacesModule, SpacesService, TransactionRunner } from '@nerve-office/api'
import { adminSpaceSchema, errorResponseSchema } from '@nerve-office/contracts'
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
let rootSession: LoggedIn
let amySession: LoggedIn
let spaces = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url, additionalModules: [SpaceNamesProbeModule] })
  root = await createAccount(database, { username: 'root', displayName: '管理员', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  rootSession = await login(app.baseUrl, 'root', root.password)
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

/** 系统管理员经接口建团队空间（艾米是首个空间管理员） */
async function create(name: string): Promise<Response> {
  return asUser(app.baseUrl, rootSession, '/api/admin/spaces', { method: 'POST', body: { name, adminUserId: amy.id, visibleToAll: false } })
}

/** 空间管理员（艾米）经接口改名 */
async function rename(spaceId: string, name: string): Promise<Response> {
  return asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/name`, { method: 'PUT', body: { name } })
}

async function codeOf(response: Response): Promise<string> {
  return parseExact(errorResponseSchema, await response.json()).error.code
}

/** 数据库算出的判重键（生成列） */
async function keyOf(spaceId: string): Promise<string | undefined> {
  return database.query(async client => (await client.query<{ name_key: string }>('SELECT name_key FROM spaces WHERE id = $1', [spaceId])).rows[0]?.name_key)
}

describe('团队空间的名称：看起来一样的名称算同一个名字（M2-P6 复核 B 的 M-1）', () => {
  it('夹着放行的格式字符、各种空格、连续空格的名称：一律 409，与原名不能并存', async () => {
    expect((await create('财务部')).status).toBe(201)
    expect((await create('Finance Team')).status).toBe(201)
    // 零宽连接符、零宽不连字、变体选择符、组合用字形连接符、变体选择符补充、标签字符、不换行空格、半角宽的空格、
    // 两个空格、窄不换行空格、蒙古文的自由变体选择符
    const lookalikes = [
      '财\u200D务部',
      '财\u200C务部',
      '财务\uFE0F部',
      '财\u034F务部',
      '财务部\u{E0100}',
      '财务部\u{E0020}',
      'Finance\u00A0Team',
      'Finance\u2002Team',
      'Finance  Team',
      'Finance\u202FTeam',
      '财务部\u180B',
    ]
    const outcomes: Record<string, string> = {}
    for (const name of lookalikes) {
      const response = await create(name)
      outcomes[JSON.stringify(name)] = response.status === 409 ? await codeOf(response) : String(response.status)
    }
    expect(outcomes).toEqual(Object.fromEntries(lookalikes.map(name => [JSON.stringify(name), 'SPACE_NAME_TAKEN'])))
    // 一个也没有建出来
    expect(await database.query(async client => (await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM spaces WHERE type = \'team\' AND name_key = ANY($1::text[])',
      [['财务部', 'finance team']],
    )).rows[0]?.count)).toBe(2)
  })

  it('其余几类看起来一样的写法：开头的零宽连接符后面跟空格、两个空格之间夹着零宽连接符、全角字母、被组合用字形连接符隔开的组合写法', async () => {
    expect((await create('Nova Lab')).status).toBe(201)
    expect((await create('Caf\u00E9 Club')).status).toBe(201)
    for (const name of ['\u200D Nova Lab', 'Nova \u200D Lab', '\uFF2E\uFF4F\uFF56\uFF41 Lab', 'Nova\u3000\u3000Lab', 'Cafe\u034F\u0301 Club']) {
      const response = await create(name)
      expect(response.status, JSON.stringify(name)).toBe(409)
      expect(await codeOf(response)).toBe('SPACE_NAME_TAKEN')
    }
  })

  it('兼容写法展开成空格的字符：带空格的声调符号（U+00B4）与"空格加组合声调符"看起来一样，先 NFKC 再合并空白才认得出', async () => {
    const spacingAcute = String.fromCharCode(0x00B4)
    const combiningAcute = String.fromCharCode(0x0301)
    expect((await create(`Memo ${spacingAcute}`)).status).toBe(201)
    const response = await create(`Memo ${combiningAcute}`)
    expect(response.status).toBe(409)
    expect(await codeOf(response)).toBe('SPACE_NAME_TAKEN')
  })

  it('大小写（不回归）：ASCII、带变音符的拉丁字母、土耳其的 İ 与 i；大小写折叠：希腊字母词尾的 ς 与 σ；组合写法与预组写法', async () => {
    const pairs: [string, string][] = [
      ['Market Ops', 'MARKET OPS'],
      ['\u00C4rzte \u00D6sterreich', '\u00E4rzte \u00F6sterreich'],
      ['\u0130STANBUL', 'istanbul'],
      ['\u039F\u0394\u039F\u03A3', '\u03BF\u03B4\u03BF\u03C2'],
      ['\u039A\u039F\u03A3\u039C\u039F\u03A3', '\u03BA\u03BF\u03C3\u03BC\u03BF\u03C2'],
      ['Cafe\u0301 Noir', 'CAF\u00C9 NOIR'],
    ]
    for (const [first, second] of pairs) {
      expect((await create(first)).status, JSON.stringify(first)).toBe(201)
      const response = await create(second)
      expect(response.status, JSON.stringify(second)).toBe(409)
      expect(await codeOf(response)).toBe('SPACE_NAME_TAKEN')
    }
  })

  it('判重键由数据库算出、存在生成列里：合并空白、去掉放行的格式字符、大小写折叠', async () => {
    const response = await create('  Ops\u3000\u00A0 Center\u200D  ')
    expect(response.status).toBe(201)
    const space = parseExact(adminSpaceSchema, await response.json())
    // 入口把中间的空白合成一个普通空格（名称照原样保留放行的零宽连接符）
    expect(space.name).toBe('Ops Center\u200D')
    expect(await keyOf(space.id)).toBe('ops center')
    const greek = parseExact(adminSpaceSchema, await (await create('\u03A3\u039F\u03A6\u0399\u0391\u03A3')).json())
    expect(await keyOf(greek.id)).toBe('\u03C3\u03BF\u03C6\u03B9\u03B1\u03C3')
  })

  it('真正不同的名称照常 201：多一个字、换了标点、多一个词', async () => {
    expect((await create('研发部')).status).toBe(201)
    for (const name of ['研发二部', '研发部（北京）', 'Research-Dev', 'Research Dev', 'Research Dev Team'])
      expect((await create(name)).status, name).toBe(201)
  })

  it('空间管理员（不是系统管理员）改名：改成他看不到的空间看起来一样的名称，409；改成真正不同的、或自己现在的名称的另一种写法，照常', async () => {
    const hidden = await teamSpace('人事部')
    const mine = await teamSpace()
    for (const name of ['人事部', '人\u200D事部', '人事\uFE0F部', '人事部\u{E0101}']) {
      const response = await rename(mine, name)
      expect(response.status, JSON.stringify(name)).toBe(409)
      expect(await codeOf(response)).toBe('SPACE_NAME_TAKEN')
    }
    expect(await namesOf([hidden, mine])).toEqual(['人事部', expect.stringMatching(/^名称测试/) as unknown])
    expect((await rename(mine, 'HR Two')).status).toBe(200)
    // 自己现在的名称的另一种写法：判重键相同，但撞的是自己这一行，不算重名
    expect((await rename(mine, 'hr\u00A0TWO')).status).toBe(200)
    expect(await namesOf([mine])).toEqual(['hr TWO'])
  })

  it('个人空间不参与判重：与团队空间的名称看起来一样也照常', async () => {
    const team = await teamSpace('市场部')
    // 直接写库建账户与个人空间：唯一索引只管团队空间，个人空间的名称（取显示名）撞上判重键也照常写入
    const twin = await createAccount(database, { username: 'twin', displayName: '市\u200D场部' })
    expect(await keyOf(twin.personalSpaceId)).toBe(await keyOf(team))
  })
})
