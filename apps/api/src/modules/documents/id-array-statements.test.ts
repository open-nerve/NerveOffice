// 仓储里按一串 id 读写的每一条语句（M2-P6 复核 A 的 S-2、B 的 G1）：不论多少个 id，都作为一个数组参数交给数据库。
// PostgreSQL 一条语句最多 65535 个参数。逐个传参（IN ($1, $2, …)）的写法在子树里的文档、连带的删除单元超过这个数时，
// 删除、永久删除、跨空间移动每次都失败，定时清理也一直清不掉那一单。
// 这里不连数据库：假的连接记下每条语句与它的参数（事务由真实的 TransactionRunner 开），用超过上限的 id 个数调用每个方法，
// 核对每条语句的参数个数与 id 的个数无关、这串 id 作为一个数组参数出现。这些语句在真实数据库上的行为由集成测试覆盖。
import type { Transaction } from '../database/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { TransactionRunner } from '../database/index.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { FoldersRepository } from './folders.repository.ts'
import { TrashEntriesRepository } from './trash-entries.repository.ts'

/** 比 PostgreSQL 一条语句的参数上限（65535）多 */
const COUNT = 70_000
const IDS = Array.from({ length: COUNT }, (_, index) => `0199a2c4-0000-7000-8000-${String(index).padStart(12, '0')}`)
const SPACE = '0199a2c4-0000-7000-8000-0000000000a1'
const USER = '0199a2c4-0000-7000-8000-00000000000a'
const ENTRY = '0199a2c4-0000-7000-8000-0000000000e1'

interface Statement {
  readonly text: string
  readonly values: readonly unknown[]
}

/** 假的连接：记下语句与参数；respond 按语句给出返回的行（默认没有行） */
function recordingClient(respond: (text: string) => unknown[] = () => []) {
  const statements: Statement[] = []
  return {
    statements,
    release: vi.fn(),
    getTransactionStatus: (): 'I' => 'I',
    query: vi.fn(async (config: string | { readonly text: string }, values?: readonly unknown[]) => {
      const text = typeof config === 'string' ? config : config.text
      statements.push({ text, values: values ?? [] })
      return { rows: respond(text), rowCount: 0, command: '', fields: [] }
    }),
  }
}

interface Repositories {
  readonly documents: DocumentsRepository
  readonly folders: FoldersRepository
  readonly entries: TrashEntriesRepository
}

/** 在一个事务里调用仓储，返回它发出的语句（去掉事务自己的 begin、确认事务可用的 SELECT 1、commit） */
async function statementsOf(call: (repositories: Repositories, transaction: Transaction) => Promise<unknown>, respond?: (text: string) => unknown[]): Promise<Statement[]> {
  const client = recordingClient(respond)
  const runner = new TransactionRunner({ connect: async () => client } as unknown as ConstructorParameters<typeof TransactionRunner>[0])
  await runner.run(async (transaction) => {
    // 事务里的执行器本身就是一个 Drizzle 实例：不收事务的方法（列表、搜索、路径）也经它发语句
    const db = transaction as unknown as ConstructorParameters<typeof DocumentsRepository>[0]
    await call({ documents: new DocumentsRepository(db), folders: new FoldersRepository(db), entries: new TrashEntriesRepository(db) }, transaction)
  })
  return client.statements.filter(statement => !/^(?:begin|commit|select 1)$/i.test(statement.text.trim()))
}

/** 每条语句只有几个参数；这串 id 作为一个数组参数出现，语句里对应的是 `= ANY($n::uuid[])` */
function expectIdArrayParameters(statements: readonly Statement[]): void {
  expect(statements.length).toBeGreaterThan(0)
  for (const statement of statements) {
    expect(statement.values.length).toBeLessThanOrEqual(8)
    expect(statement.values).toContainEqual(IDS)
    expect(statement.text).toMatch(/= ANY\(\$\d+::uuid\[\]\)/)
    expect(statement.text).not.toMatch(/\bin \(\$\d+, \$\d+/i)
  }
}

type Call = (repositories: Repositories, transaction: Transaction) => Promise<unknown>

const DOCUMENTS: Readonly<Record<string, Call>> = {
  '列出可访问的文档（看得到的空间）': async ({ documents }) => documents.listAccessible({ spaceIds: IDS }, { limit: 10 }),
  '按标题搜索（看得到的空间）': async ({ documents }) => documents.searchByTitle({ spaceIds: IDS }, { limit: 10, titlePattern: '%周报%' }),
  '停用者文档的转移：锁住要转的文档': async ({ documents }, transaction) => documents.lockForTransfer(IDS, SPACE, transaction),
  '锁住这些文件夹里的文档（删除、跨空间移动、永久删除）': async ({ documents }, transaction) => documents.lockInFolders(IDS, SPACE, transaction),
  '锁住属于这些删除单元的文档': async ({ documents }, transaction) => documents.lockInEntries(IDS, transaction),
  '编辑者删文件夹：数别人的文档': async ({ documents }, transaction) => documents.countCreatedByOthers(IDS, SPACE, USER, transaction),
  '永久删除之前：数正常状态的文档': async ({ documents }, transaction) => documents.countActiveInFolders(IDS, transaction),
  '放进回收站': async ({ documents }, transaction) => documents.trash(IDS, ENTRY, transaction),
  '每个删除单元里的份数': async ({ documents }, transaction) => documents.countByTrashEntries(IDS, transaction),
  '永久删除': async ({ documents }, transaction) => documents.deleteMany(IDS, transaction),
  '跨空间移动': async ({ documents }, transaction) => documents.moveToSpace(IDS, SPACE, undefined, transaction),
}

const FOLDERS: Readonly<Record<string, Call>> = {
  '搜索结果的路径（起点与看得到的空间）': async ({ folders }) => folders.ancestorsOf(IDS, IDS),
  '永久删除之前：数正常状态的文件夹': async ({ folders }, transaction) => folders.countActive(IDS, transaction),
  '这些文件夹分属的删除单元': async ({ folders }, transaction) => folders.trashEntryIdsIn(IDS, transaction),
  '每个删除单元里的文件夹数': async ({ folders }, transaction) => folders.countByTrashEntries(IDS, transaction),
  '回收站列表里原位置的名称': async ({ folders }) => folders.activeNamesOf(IDS, SPACE),
  '整棵子树放进回收站': async ({ folders }, transaction) => folders.trashMany(IDS, ENTRY, transaction),
}

const TRASH_ENTRIES: Readonly<Record<string, Call>> = {
  '到期的删除单元（让开暂缓重试的那些）': async ({ entries }) => entries.listExpired(new Date('2026-10-28T03:00:00.000Z'), 50, IDS),
  '跨空间移动时迁走删除单元': async ({ entries }, transaction) => entries.moveToSpace(IDS, SPACE, transaction),
  '删掉删除单元': async ({ entries }, transaction) => entries.deleteMany(IDS, transaction),
}

describe(`仓储按一串 id 读写：${COUNT} 个 id 也只有一个数组参数`, () => {
  for (const [name, call] of Object.entries({ ...DOCUMENTS, ...FOLDERS, ...TRASH_ENTRIES })) {
    it(name, async () => {
      expectIdArrayParameters(await statementsOf(call))
    })
  }

  it('永久删除文件夹：按层数从深到浅逐层删，取层数与每一层的删除都只有一个数组参数', async () => {
    // 取层数的语句返回两层（行按列的顺序给出）；每一层删一次
    const statements = await statementsOf(async ({ folders }, transaction) => folders.deleteMany(IDS, transaction), text => text.startsWith('select distinct') ? [[3], [2]] : [])
    expect(statements.map(statement => statement.text.split(' ')[0])).toEqual(['select', 'delete', 'delete'])
    expectIdArrayParameters(statements)
  })

  it('到期的删除单元：让开的那些写成 NOT (id = ANY(…))；没有要让开的就不带这个条件', async () => {
    const [except] = await statementsOf(TRASH_ENTRIES['到期的删除单元（让开暂缓重试的那些）'] ?? (async () => undefined))
    expect(except?.text).toMatch(/not "trash_entries"\."id" = ANY\(\$2::uuid\[\]\)/)
    const [none] = await statementsOf(async ({ entries }) => entries.listExpired(new Date('2026-10-28T03:00:00.000Z'), 50))
    expect(none?.text).not.toMatch(/ANY/)
    expect(none?.values).toHaveLength(2)
  })
})
