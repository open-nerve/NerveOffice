// 团队空间的名称（M2-P2 设计 §3.2、§3.9）：按判重键唯一（看起来一样的名称算同一个名字，M2-P6 复核 B 的 M-1），
// 由唯一索引兜住并发；创建与改名撞上唯一约束时只回滚到保存点，事务仍可继续（M2-P2 审查 A6）：经测试探针在一个事务里撞名之后再改一次。
// 显示成空白的非格式字符（盲文空白等）：入口拒绝，判重键把入口拒绝之前写进去的当空白（M2-P6 复验 R-M1）；
// 判得偏严的写法（蒙古文的元音分隔符，复验 R-G1）有用例钉住。
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
    // 入口把中间连续的空白合成一个、保留这一段里的第一个（全角空格，M2-P6 复验 R-G4）；名称照原样保留放行的零宽连接符。
    // 判重键里所有空白都是同一个空格
    expect(space.name).toBe('Ops\u3000Center\u200D')
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
    // 单个的不换行空格原样保留（M2-P6 复验 R-G4）
    expect(await namesOf([mine])).toEqual(['hr\u00A0TWO'])
  })

  it('个人空间不参与判重：与团队空间的名称看起来一样也照常', async () => {
    const team = await teamSpace('市场部')
    // 直接写库建账户与个人空间：唯一索引只管团队空间，个人空间的名称（取显示名）撞上判重键也照常写入
    const twin = await createAccount(database, { username: 'twin', displayName: '市\u200D场部' })
    expect(await keyOf(twin.personalSpaceId)).toBe(await keyOf(team))
  })
})

/** 直接写库建一个团队空间（艾米是空间管理员）：模拟名称的入口拒绝某些字符之前写进去的数据 */
async function legacyTeamSpace(name: string): Promise<string> {
  return createTeamSpace(database, { name, createdBy: root.id, members: { [amy.id]: 'admin' } })
}

let freshNames = 0
/** 每次一个新的名称：探针在撞名之后，同一个事务里接着建、接着改的那一个 */
function freshName(prefix: string): string {
  freshNames += 1
  return `${prefix} ${freshNames}`
}

/** 显示成空白的非格式字符（contracts 的 BLANK_LOOKING_CHARACTERS）：盲文空白、契丹小字填充符、乐谱的空符头 */
const BLANK_LOOKING = ['\u2800', '\u{16FE4}', '\u{1D159}']

describe('团队空间的名称：显示成空白的非格式字符（M2-P6 复验 R-M1）', () => {
  it('入口拒绝：已有"财务组"时新建末尾带它的、用它代替空格的，一律 400，一个也没有建出来', async () => {
    expect((await create('财务组')).status).toBe(201)
    expect((await create('财 务处')).status).toBe(201)
    for (const character of BLANK_LOOKING) {
      for (const name of [`财务组${character}`, `财${character}务处`]) {
        const response = await create(name)
        expect(response.status, JSON.stringify(name)).toBe(400)
        expect(await codeOf(response)).toBe('REQUEST_INVALID')
      }
    }
    expect(await database.query(async client => (await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM spaces WHERE type = \'team\' AND name_key = ANY($1::text[])',
      [['财务组', '财 务处']],
    )).rows[0]?.count)).toBe(2)
  })

  it('入口拒绝：空间管理员把自己的空间改名成已有的"人事组"加一个它，400，名称不变', async () => {
    await teamSpace('人事组')
    const mine = await teamSpace()
    expect((await rename(mine, '人事组')).status).toBe(409)
    for (const character of BLANK_LOOKING) {
      const response = await rename(mine, `人事组${character}`)
      expect(response.status, JSON.stringify(character)).toBe(400)
      expect(await codeOf(response)).toBe('REQUEST_INVALID')
    }
    expect(await namesOf([mine])).toEqual([expect.stringMatching(/^名称测试/) as unknown])
  })

  it('判重键把它们当空白：不经入口、直接交给服务（新建与改名），撞上唯一索引，SPACE_NAME_TAKEN（接口上是 409）', async () => {
    await teamSpace('采购组')
    await teamSpace('采 购处')
    for (const character of BLANK_LOOKING) {
      for (const taken of [`采购组${character}`, `采${character}购处`, `${character}采购组`]) {
        const created = await probe('create', { taken, fresh: freshName('采购新组'), createdBy: root.id, adminUserId: amy.id })
        expect(created.first, JSON.stringify(taken)).toBe('SPACE_NAME_TAKEN')
        const renamed = await probe('rename', { spaceId: await teamSpace(), taken, fresh: freshName('采购改名') })
        expect(renamed.first, JSON.stringify(taken)).toBe('SPACE_NAME_TAKEN')
      }
    }
  })

  it('入口拒绝它们之前写进去的名称（带着它们）：再建、改成看起来一样的名称，409；判重键里它们与空白一起合成一个空格', async () => {
    const legacy = [
      await legacyTeamSpace('财务科\u2800'),
      await legacyTeamSpace('人\u2800事科'),
      await legacyTeamSpace('\u{16FE4}总务科'),
      await legacyTeamSpace('行政\u{1D159}\u2800 科'),
    ]
    expect(await Promise.all(legacy.map(keyOf))).toEqual(['财务科', '人 事科', '总务科', '行政 科'])
    for (const name of ['财务科', '人 事科', '人\u3000事科', '总务科', '行政 科']) {
      const response = await create(name)
      expect(response.status, JSON.stringify(name)).toBe(409)
      expect(await codeOf(response)).toBe('SPACE_NAME_TAKEN')
    }
    const mine = await teamSpace()
    for (const name of ['财务科', '人 事科']) {
      const response = await rename(mine, name)
      expect(response.status, JSON.stringify(name)).toBe(409)
      expect(await codeOf(response)).toBe('SPACE_NAME_TAKEN')
    }
  })
})

/** 蒙古文字母：na U+1828、a U+1820、ra U+1837、ha U+182C；元音分隔符 MVS U+180E（名称里只在正字法位置上放行） */
const MONGOLIAN = { na: '\u1828', a: '\u1820', ra: '\u1837', ha: '\u182C', mvs: '\u180E' }

describe('团队空间的名称：判得偏严的写法（M2-P6 复验 R-G1）', () => {
  const { na, a, ra, ha, mvs } = MONGOLIAN

  it('蒙古文：正字法位置上的元音分隔符在判重时不算区别，带与不带的两个名称算同一个名字（两个方向）', async () => {
    // nar-a（名字"娜拉"的写法）：分隔符改变词尾 a 的字形，但与不带它的写法判成重名——
    // 接受判得偏严（换个名字即可；偏宽会让人认错空间）
    const withSeparator = parseExact(adminSpaceSchema, await (await create(`${na}${a}${ra}${mvs}${a}`)).json())
    expect(withSeparator.name).toBe(`${na}${a}${ra}${mvs}${a}`)
    expect(await keyOf(withSeparator.id)).toBe(`${na}${a}${ra}${a}`)
    const without = await create(`${na}${a}${ra}${a}`)
    expect(without.status).toBe(409)
    expect(await codeOf(without)).toBe('SPACE_NAME_TAKEN')
    // 反过来：先有不带的 qara，再建带分隔符的 qar-a
    expect((await create(`${ha}${a}${ra}${a}`)).status).toBe(201)
    const withAfter = await create(`${ha}${a}${ra}${mvs}${a}`)
    expect(withAfter.status).toBe(409)
    expect(await codeOf(withAfter)).toBe('SPACE_NAME_TAKEN')
  })
})

let pairs = 0
/** 逐对核对：先建 first（要 201），再建 other，返回后者的状态码。每一对加一个不同的后缀，免得与别的对撞名 */
async function secondOf(first: string, other: string): Promise<number> {
  pairs += 1
  const suffix = ` #${pairs}`
  expect((await create(`${first}${suffix}`)).status, JSON.stringify(first)).toBe(201)
  return (await create(`${other}${suffix}`)).status
}

describe('团队空间的名称：逐对核对看起来一样的与看起来不同的（M2-P6 复验）', () => {
  /**
   * 看起来一样的两个名称，第二个的结果：400 是名称的入口先拒绝了（看不见的字符、显示成空白的字符）；
   * 201 是已知不处理的跨文字同形字（拉丁字母与西里尔、希腊字母长得一样的几个，兼容写法里样子相近的分数）：
   * 判重键不做"同形字的骨架"，这一类登记为 DEF-032，由 M7 的安全审查处理
   */
  const LOOKALIKES: readonly (readonly [string, string, string, number])[] = [
    ['盲文空白在末尾', '财务部', '财务部\u2800', 400],
    ['盲文空白代替空格', '财 务部', '财\u2800务部', 400],
    ['契丹小字填充符', '财务部', '财务部\u{16FE4}', 400],
    ['乐谱的空符头', '财务部', '财务部\u{1D159}', 400],
    ['韩文填充符', '财务部', '财务部\u3164', 400],
    ['半角韩文填充符', '财务部', '财务部\uFFA0', 400],
    ['西里尔字母 а 代替拉丁字母 a（DEF-032）', 'Finance', 'Fin\u0430nce', 201],
    ['希腊字母 Ο 代替拉丁字母 O（DEF-032）', 'Ops', '\u039Fps', 201],
    ['分数 ½ 与 1/2（NFKC 展开成分数斜线，不是斜线，DEF-032）', '1/2 组', '\u00BD 组', 201],
  ]
  it.each(LOOKALIKES)('看起来一样：%s', async (_name, first, other, expected) => {
    expect(first).not.toBe(other)
    expect(await secondOf(first, other)).toBe(expected)
  })

  /**
   * 看起来不同（或者不完全一样）的两个名称，第二个的结果：409 是判得偏严——国旗的标签字符、零宽连接符组合的表情、
   * 波斯文的零宽不连字与天城文的零宽连接符在判重时不算区别，兼容写法按 NFKC 归成一样。需求方接受判得偏严（M2-P6 复验 R-G1）：
   * 名称唯一是为了在导航里区分，偏严只是要换个名字，偏宽会让人认错空间。蒙古文的元音分隔符另见上面的用例
   */
  const DISTINCT: readonly (readonly [string, string, string, number])[] = [
    ['英格兰旗与苏格兰旗', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} 球迷会', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} 球迷会', 409],
    ['英格兰旗与黑旗', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} 球迷会', '\u{1F3F4} 球迷会', 409],
    ['一家人（零宽连接符组合）与三个人', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} 家庭组', '\u{1F468}\u{1F469}\u{1F467} 家庭组', 409],
    ['波斯文带零宽不连字与不带', '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', '\u0645\u06CC\u062E\u0648\u0627\u0647\u0645', 409],
    ['天城文半字形（零宽连接符）与连字', '\u0915\u094D\u200D\u0937', '\u0915\u094D\u0937', 409],
    ['㍿ 与 株式会社', '\u337F', '株式会社', 409],
    ['带圈数字与数字', '第\u2460组', '第1组', 409],
    ['下标数字与数字', 'H\u2082O', 'H2O', 409],
    ['™ 与 TM', '\u2122 Club', 'TM Club', 409],
    ['连字 ﬁ 与 fi（看起来一样，判重正确）', '\uFB01nance', 'finance', 409],
    ['带空格的声调符号与"空格加带空格的声调符号"', 'a\u00B4b', 'a \u00B4b', 409],
    ['ß 与 ss（内置 C.UTF-8 的大小写折叠是简单折叠，不误伤）', 'Stra\u00DFe', 'Strasse', 201],
  ]
  it.each(DISTINCT)('看起来不同：%s', async (_name, first, other, expected) => {
    expect(first).not.toBe(other)
    expect(await secondOf(first, other)).toBe(expected)
  })
})
