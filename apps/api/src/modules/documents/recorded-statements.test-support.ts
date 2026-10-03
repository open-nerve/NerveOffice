// 不连数据库，记下仓储发出的语句（M2-P6 复核 A 的 S-2 起）：假的连接记下每条语句与它的参数，事务由真实的 TransactionRunner 开。
// 用来核对语句的形状——参数的个数、条件、加锁的对象与顺序；这些语句在真实数据库上的行为由集成测试覆盖。
import type { Transaction } from '../database/index.ts'
import { vi } from 'vitest'
import { CommitLedger, SnapshotScope, TransactionRunner } from '../database/index.ts'

/** 一条语句：SQL 文本与绑定的参数 */
export interface RecordedStatement {
  readonly text: string
  readonly values: readonly unknown[]
}

/** 假的连接：记下语句与参数；respond 按语句给出返回的行（数组形式，按列的顺序；默认没有行） */
function recordingClient(respond: (text: string) => unknown[]) {
  const statements: RecordedStatement[] = []
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

/**
 * 在一个事务里执行 work，返回它发出的语句（去掉事务自己的 begin、确认事务可用的 SELECT 1、commit）。
 * work 拿到的 executor 是事务里的执行器，它本身就是一个 Drizzle 实例：拿它构造仓储（按仓储构造参数的类型转换），
 * 不收事务的方法也经它发语句
 */
export async function recordStatements(work: (executor: unknown, transaction: Transaction) => Promise<unknown>, respond: (text: string) => unknown[] = () => []): Promise<RecordedStatement[]> {
  const client = recordingClient(respond)
  const runner = new TransactionRunner({ connect: async () => client } as unknown as ConstructorParameters<typeof TransactionRunner>[0], new CommitLedger(), new SnapshotScope())
  await runner.run(async transaction => work(transaction, transaction))
  return client.statements.filter(statement => !/^(?:begin|commit|select 1)$/i.test(statement.text.trim()))
}
