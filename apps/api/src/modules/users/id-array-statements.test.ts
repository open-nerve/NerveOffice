// 账户的仓储按一串 id 读（M2-P5 审查 B 的 G6）：不论多少个 id，这串 id 作为一个数组参数交给数据库（database 模块的 inIdArray，规范 §5）。
// 授权列表、成员列表补人名时的人数没有分页的上界：逐个传参（IN ($1, $2, …)）的写法超过 PostgreSQL 一条语句的参数上限（65535）就失败。
// 不连数据库：假的连接记下每条语句与它的参数（事务由真实的 TransactionRunner 开，与 documents/id-array-statements.test.ts 同一个做法）。
// lint 另外拦下 users 的仓储引用 drizzle 的 inArray、notInArray（eslint.config.ts 的 API_ID_LISTS）
import type { Transaction } from '../database/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { CommitLedger, TransactionRunner } from '../database/index.ts'
import { UsersRepository } from './users.repository.ts'

/** 比 PostgreSQL 一条语句的参数上限（65535）多 */
const COUNT = 70_000
const IDS = Array.from({ length: COUNT }, (_, index) => `0199a2c4-0000-7000-8000-${String(index).padStart(12, '0')}`)

interface Statement {
  readonly text: string
  readonly values: readonly unknown[]
}

/** 假的连接：记下语句与参数，不返回行 */
function recordingClient() {
  const statements: Statement[] = []
  return {
    statements,
    release: vi.fn(),
    getTransactionStatus: (): 'I' => 'I',
    query: vi.fn(async (config: string | { readonly text: string }, values?: readonly unknown[]) => {
      statements.push({ text: typeof config === 'string' ? config : config.text, values: values ?? [] })
      return { rows: [], rowCount: 0, command: '', fields: [] }
    }),
  }
}

/** 在一个事务里调用仓储，返回它发出的语句（去掉事务自己的 begin、确认事务可用的 SELECT 1、commit） */
async function statementsOf(call: (repository: UsersRepository, transaction: Transaction) => Promise<unknown>): Promise<Statement[]> {
  const client = recordingClient()
  const runner = new TransactionRunner({ connect: async () => client } as unknown as ConstructorParameters<typeof TransactionRunner>[0], new CommitLedger())
  await runner.run(async (transaction) => {
    // 事务里的执行器本身就是一个 Drizzle 实例：不传事务的调用也经它发语句
    await call(new UsersRepository(transaction as unknown as ConstructorParameters<typeof UsersRepository>[0]), transaction)
  })
  return client.statements.filter(statement => !/^(?:begin|commit|select 1)$/i.test(statement.text.trim()))
}

describe(`UsersRepository.findByIds：${COUNT} 个 id 也只有一个数组参数`, () => {
  it.each([
    ['不在事务里（审计、授权列表、成员列表补人名）', async (repository: UsersRepository) => repository.findByIds(IDS)],
    ['在写操作的事务里（分享、加成员之后拼响应）', async (repository: UsersRepository, transaction: Transaction) => repository.findByIds(IDS, transaction)],
  ] as const)('%s', async (_name, call) => {
    const statements = await statementsOf(call)
    expect(statements).toHaveLength(1)
    const [statement] = statements
    expect(statement?.values).toEqual([IDS])
    expect(statement?.text).toMatch(/where "users"\."id" = ANY\(\$1::uuid\[\]\)$/)
    expect(statement?.text).not.toMatch(/\bin \(\$\d+, \$\d+/i)
  })

  it('没有 id：不发语句', async () => {
    expect(await statementsOf(async repository => repository.findByIds([]))).toEqual([])
  })
})
