import type { Request, Response } from 'express'
import type pg from 'pg'
import type { DbTransaction, Transaction } from './database.ts'
import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { databaseBusyReasonOf, LateTransactionStartError } from './busy-errors.ts'
import { CommitLedger } from './commit-ledger.ts'
import { SnapshotScope } from './snapshot-scope.ts'
import { NESTED_IN_SNAPSHOT_MESSAGE, TRANSACTION_ABORTED_MESSAGE, TransactionRunner } from './transaction-runner.ts'

type TransactionStatus = 'I' | 'T' | 'E'

/**
 * 假的连接：记下执行过的语句；failOn 里的语句（按第一个词）执行时报错。
 * 事务状态按 PostgreSQL 的规则变化：BEGIN 之后在事务中，事务中的语句失败后事务中止，COMMIT、ROLLBACK 之后空闲；
 * 事务中止之后，除了 ROLLBACK，任何语句都报 25P02。
 * 设下时限的那一条语句（带 transaction_timeout 的）交回 BEGIN 之后过了多久：elapsedMs（默认 1.5 毫秒，一次往返）
 */
function fakeClient(failOn: readonly string[] = [], answers: { readonly elapsedMs?: number | null } = {}) {
  const statements: string[] = []
  /** 每条语句绑定的参数（与 statements 一一对应；drizzle 以第二个参数传入） */
  const parameters: (readonly unknown[] | undefined)[] = []
  let status: TransactionStatus = 'I'
  return {
    statements,
    parameters,
    release: vi.fn(),
    getTransactionStatus: vi.fn((): TransactionStatus => status),
    /** 模拟事务里有语句失败，而 work 把错误吞掉了 */
    abort: () => {
      status = 'E'
    },
    query: vi.fn(async (config: { text: string }, values?: readonly unknown[]) => {
      statements.push(config.text)
      parameters.push(values)
      const verb = prefix(config.text).toLowerCase()
      if (status === 'E' && verb !== 'rollback')
        throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' })
      if (failOn.includes(verb)) {
        if (status === 'T')
          status = 'E'
        throw new Error(`${verb} 失败`)
      }
      if (verb === 'begin')
        status = 'T'
      else if (verb === 'commit' || verb === 'rollback')
        status = 'I'
      if (config.text.includes('transaction_timeout'))
        return { rows: [{ elapsed_ms: answers.elapsedMs === undefined ? 1.5 : answers.elapsedMs }], rowCount: 1, command: 'SELECT', fields: [] }
      return { rows: [], rowCount: 0, command: '', fields: [] }
    }),
  }
}

function prefix(text: string): string {
  return (text.split(' ')[0] ?? text).toLowerCase()
}

function runnerWith(client: ReturnType<typeof fakeClient>, commits = new CommitLedger(), snapshots = new SnapshotScope()): TransactionRunner {
  const pool = { connect: vi.fn(async () => client) }
  return new TransactionRunner(pool as unknown as pg.Pool, commits, snapshots)
}

/** 在一个请求的记录里执行 work：与 HTTP 管线里同一个中间件 */
async function inRequest<T>(commits: CommitLedger, work: () => Promise<T>): Promise<T> {
  let pending: Promise<T> | undefined
  commits.middleware()({} as Request, {} as Response, () => {
    pending = work()
  })
  if (pending === undefined)
    throw new Error('中间件没有往下走')
  return pending
}

describe('TransactionRunner', () => {
  it('work 正常结束：确认事务可用，提交，连接照常放回', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).run(async () => 42)).resolves.toBe(42)
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'commit'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('业务错误（AppError）：回滚成功，抛出原来的错误，连接照常放回', async () => {
    const client = fakeClient()
    const error = new AppError('NOT_FOUND')
    await expect(runnerWith(client).run(async () => {
      throw error
    })).rejects.toBe(error)
    expect(client.statements.map(prefix)).toEqual(['begin', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('其他错误（例如查询超时）：回滚后丢弃连接，它可能已经断开或半开', async () => {
    const client = fakeClient()
    const error = new Error('Query read timeout')
    await expect(runnerWith(client).run(async () => {
      throw error
    })).rejects.toBe(error)
    expect(client.statements.map(prefix)).toEqual(['begin', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('BEGIN 失败：连接同样归还并丢弃，不会泄漏（drizzle 自己的 transaction() 在这里不归还连接）', async () => {
    const client = fakeClient(['begin'])
    const work = vi.fn(async () => 1)
    await expect(runnerWith(client).run(work)).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('COMMIT 失败：丢弃连接', async () => {
    const client = fakeClient(['commit'])
    await expect(runnerWith(client).run(async () => 1)).rejects.toThrow()
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('业务错误之后回滚也失败：抛出的是回滚的错误，丢弃连接', async () => {
    const client = fakeClient(['rollback'])
    await expect(runnerWith(client).run(async () => {
      throw new AppError('NOT_FOUND')
    })).rejects.not.toBeInstanceOf(AppError)
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('work 吞掉了失败的语句却正常返回：事务已中止，不当作成功，回滚并丢弃连接', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).run(async () => {
      client.abort()
      return 1
    })).rejects.toThrow(TRANSACTION_ABORTED_MESSAGE)
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('不依赖连接上记下的事务状态：状态还没更新（驱动先收到错误、后收到 ReadyForQuery）时同样发现事务已中止', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).run(async () => {
      client.abort()
      // 模拟状态还停在"事务中"：确认要靠真正执行一条语句
      client.getTransactionStatus.mockReturnValueOnce('T')
      return 1
    })).rejects.toThrow(TRANSACTION_ABORTED_MESSAGE)
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'rollback'])
  })

  it('确认的语句因为别的原因失败（例如连接断开）：原样抛出，丢弃连接', async () => {
    const client = fakeClient(['select'])
    await expect(runnerWith(client).run(async () => 1)).rejects.not.toThrow(TRANSACTION_ABORTED_MESSAGE)
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('归还时连接不是空闲状态（例如 ROLLBACK 没能发出）：即使是业务错误也丢弃', async () => {
    const client = fakeClient()
    client.getTransactionStatus.mockReturnValue('T')
    await expect(runnerWith(client).run(async () => {
      throw new AppError('NOT_FOUND')
    })).rejects.toBeInstanceOf(AppError)
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('取不到连接：直接抛出，没有要归还的连接', async () => {
    const pool = { connect: vi.fn(async () => {
      throw new Error('timeout exceeded when trying to connect')
    }) }
    await expect(new TransactionRunner(pool as unknown as pg.Pool, new CommitLedger(), new SnapshotScope()).run(async () => 1)).rejects.toThrow('timeout exceeded')
  })
})

/** 与 pg 的 DatabaseError 同样的形状（SQLSTATE 与严重级别），包在 drizzle 的错误里（cause） */
function failedQuery(code: string, severity: 'ERROR' | 'FATAL'): Error {
  const cause = Object.assign(new Error(`数据库报错 ${code}`), { code, severity })
  return Object.assign(new Error('Failed query: select 1\nparams: ', { cause }), { query: 'select 1', params: [] })
}

/** 保存用的那种时限：设下之后 60 秒，BEGIN 到设下至多 10 秒 */
const LIMIT = { timeoutMs: 60_000, startWithinMs: 10_000 }

/** 设下时限的那一条语句（空白压成一个空格，便于核对写法） */
function limitStatementOf(client: ReturnType<typeof fakeClient>): string {
  return (client.statements[1] ?? '').replaceAll(/\s+/g, ' ')
}

describe('TransactionRunner：限时的事务（limit，M3-P5 复验 C1、再复核 D1、D2）', () => {
  it('BEGIN 之后的第一条语句设下时限，再执行 work、确认、提交；不带时限的事务不设', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).run(async (transaction) => {
      await select(transaction, 'work')
      return 1
    }, { limit: LIMIT })).resolves.toBe(1)
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'select', 'select', 'commit'])
    expect(client.statements[2]).toBe('select \'work\'')
    expect(client.parameters[1]).toEqual(['60000'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)

    const unlimited = fakeClient()
    await runnerWith(unlimited).run(async transaction => select(transaction, 'work'))
    expect(unlimited.statements.map(prefix)).toEqual(['begin', 'select', 'select', 'commit'])
    expect(unlimited.statements.join('\n')).not.toContain('transaction_timeout')
  })

  it('那一条语句的写法（再复核 D1、D2）：同一条语句里先把 transaction_timeout 设成 0（停掉会话默认值已经启动的计时器）、再设时限（从这一刻重新计时），先后由数据依赖强制——内层的 set_config 是外层的参数；读 BEGIN 之后过了多久放在外层 CASE 的条件成立之后；都只管这个事务（第三个参数为真）', async () => {
    const client = fakeClient()
    await runnerWith(client).run(async () => 1, { limit: LIMIT })
    const statement = limitStatementOf(client)
    expect(statement).toContain('CASE WHEN set_config(\'transaction_timeout\', CASE WHEN set_config(\'transaction_timeout\', \'0\', true) IS NOT NULL THEN $1 END, true) IS NOT NULL THEN (extract(epoch FROM clock_timestamp() - transaction_timestamp()) * 1000)::float8 END')
    // 只有这一条语句碰 transaction_timeout：不拆成两条（两条之间没有计时器）
    expect(client.statements.filter(text => text.includes('transaction_timeout'))).toHaveLength(1)
  })

  it('BEGIN 之后过了多久不超过上限（等于上限也算没超过）：照常开始', async () => {
    const client = fakeClient([], { elapsedMs: 10_000 })
    await expect(runnerWith(client).run(async () => 'ok', { limit: LIMIT })).resolves.toBe('ok')
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'select', 'commit'])
  })

  it('BEGIN 之后过了太久才设下时限（超过 startWithinMs，再复核 D1：应用在 BEGIN 与第一条语句之间停住了）：不开始——work 不执行、回滚，交出 LateTransactionStartError（算超过事务的时限，数据库繁忙），不记提交、丢弃连接', async () => {
    const client = fakeClient([], { elapsedMs: 10_000.5 })
    const work = vi.fn(async () => 1)
    const commits = new CommitLedger()
    const outcome = await inRequest(commits, async () => {
      const error = await runnerWith(client, commits).run(work, { limit: LIMIT }).then(() => undefined, (rejected: unknown) => rejected)
      return { error, committed: commits.hasCommitted() }
    })
    expect(outcome.error).toBeInstanceOf(LateTransactionStartError)
    expect(outcome.error).toMatchObject({ elapsedMs: 10_000.5, startWithinMs: 10_000 })
    expect(databaseBusyReasonOf(outcome.error)).toBe('transaction_timeout')
    expect(outcome.committed).toBe(false)
    expect(work).not.toHaveBeenCalled()
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('那一条语句没有交回 BEGIN 之后过了多久（不该发生）：当作意外错误，不开始、回滚', async () => {
    const client = fakeClient([], { elapsedMs: null })
    const work = vi.fn(async () => 1)
    await expect(runnerWith(client).run(work, { limit: LIMIT })).rejects.toThrow('设下事务的时限时没有读到 BEGIN 之后过了多久')
    expect(work).not.toHaveBeenCalled()
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'rollback'])
  })

  it('超过时限：数据库结束整个会话（work 的语句得到 FATAL 25P04），回滚随之失败——交出的是 25P04（数据库繁忙：确定没有生效，回 503），不是回滚的错误；丢弃连接，不记提交', async () => {
    const client = fakeClient(['rollback'])
    const timedOut = failedQuery('25P04', 'FATAL')
    const commits = new CommitLedger()
    const outcome = await inRequest(commits, async () => {
      const error = await runnerWith(client, commits).run(async () => {
        throw timedOut
      }, { limit: LIMIT }).then(() => undefined, (rejected: unknown) => rejected)
      return { error, committed: commits.hasCommitted() }
    })
    expect(outcome).toEqual({ error: timedOut, committed: false })
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('回滚也失败时，work 的错误是别的数据库繁忙（等锁超时）同样交出它（没有生效）；不是数据库繁忙的（违反约束；业务错误见上面）照旧交出回滚的错误（意外错误），都丢弃连接', async () => {
    const lockTimeout = failedQuery('55P03', 'ERROR')
    const locked = fakeClient(['rollback'])
    await expect(runnerWith(locked).run(async () => {
      throw lockTimeout
    })).rejects.toBe(lockTimeout)
    expect(locked.release).toHaveBeenCalledExactlyOnceWith(true)

    const violation = failedQuery('23505', 'ERROR')
    const violated = fakeClient(['rollback'])
    await expect(runnerWith(violated).run(async () => {
      throw violation
    })).rejects.toThrow('Failed query: rollback')
    expect(violated.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('时限的两个数都要是正整数毫秒：不然不借连接、直接报错（接线错误）', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const limit of [{ ...LIMIT, timeoutMs: bad }, { ...LIMIT, startWithinMs: bad }]) {
        const pool = { connect: vi.fn(async () => fakeClient()) }
        await expect(new TransactionRunner(pool as unknown as pg.Pool, new CommitLedger(), new SnapshotScope()).run(async () => 1, { limit }), JSON.stringify(limit)).rejects.toThrow('事务的时限要是正整数毫秒')
        expect(pool.connect, JSON.stringify(limit)).not.toHaveBeenCalled()
      }
    }
  })
})

describe('TransactionRunner：提交之后在这个请求的记录上记一笔（CommitLedger，M2-P6 第 3 片复验）', () => {
  it('COMMIT 成功之后才记：work 里（还没提交）看到的是没有提交过，返回之后是提交过', async () => {
    const commits = new CommitLedger()
    const client = fakeClient()
    const seen = await inRequest(commits, async () => {
      const during = await runnerWith(client, commits).run(async () => commits.hasCommitted())
      return { during, after: commits.hasCommitted() }
    })
    expect(seen).toEqual({ during: false, after: true })
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'commit'])
  })

  it('回滚（业务错误、意外错误、事务已中止）与 COMMIT 失败都不记', async () => {
    const outcomes: [string, ReturnType<typeof fakeClient>, () => Promise<unknown>][] = []
    const rolledBack = fakeClient()
    outcomes.push(['业务错误', rolledBack, async () => {
      throw new AppError('NOT_FOUND')
    }])
    const failed = fakeClient()
    outcomes.push(['意外错误', failed, async () => {
      throw new Error('Query read timeout')
    }])
    const aborted = fakeClient()
    outcomes.push(['事务已中止', aborted, async () => {
      aborted.abort()
    }])
    outcomes.push(['COMMIT 失败', fakeClient(['commit']), async () => 1])
    for (const [name, client, work] of outcomes) {
      const commits = new CommitLedger()
      const committed = await inRequest(commits, async () => {
        await runnerWith(client, commits).run(work).catch(() => undefined)
        return commits.hasCommitted()
      })
      expect(committed, name).toBe(false)
    }
  })

  it('不在请求里（命令行、定时任务）：照常提交，没有记录可记', async () => {
    const commits = new CommitLedger()
    await expect(runnerWith(fakeClient(), commits).run(async () => 1)).resolves.toBe(1)
    expect(commits.hasCommitted()).toBe(false)
  })
})

/** 在快照的事务上发一条语句：测试里把不透明的事务换回执行器（服务只能把事务原样传给仓储） */
async function select(transaction: Transaction, label: 'opening' | 'work'): Promise<void> {
  const executor = transaction as unknown as DbTransaction
  await (label === 'opening' ? executor.execute(sql`select 'opening'`) : executor.execute(sql`select 'work'`))
}

describe('TransactionRunner.readSnapshot：读请求的只读快照（M2 Codex 评审 CX1）', () => {
  it('REPEATABLE READ、READ ONLY：先执行登记的开场核对（第一条语句），再执行 work，COMMIT；不记提交、不另发确认的语句，连接照常放回', async () => {
    const client = fakeClient()
    const commits = new CommitLedger()
    const runner = runnerWith(client, commits)
    runner.registerSnapshotOpening(async transaction => select(transaction, 'opening'))
    const seen = await inRequest(commits, async () => {
      const value = await runner.readSnapshot(async (transaction) => {
        await select(transaction, 'work')
        return 7
      })
      return { value, committed: commits.hasCommitted() }
    })
    expect(seen).toEqual({ value: 7, committed: false })
    expect(client.statements).toEqual(['begin isolation level repeatable read read only', 'select \'opening\'', 'select \'work\'', 'commit'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('开场核对不通过（AppError，例如登录已过期）：work 不执行，回滚，连接照常放回', async () => {
    const client = fakeClient()
    const runner = runnerWith(client)
    const expired = new AppError('SESSION_EXPIRED')
    runner.registerSnapshotOpening(async () => {
      throw expired
    })
    const work = vi.fn(async () => 1)
    await expect(runner.readSnapshot(work)).rejects.toBe(expired)
    expect(work).not.toHaveBeenCalled()
    expect(client.statements.map(prefix)).toEqual(['begin', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('归还连接的规则与 run() 一致：业务错误回滚后放回，其他错误回滚后丢弃，BEGIN 失败也归还并丢弃', async () => {
    const business = fakeClient()
    await expect(runnerWith(business).readSnapshot(async () => {
      throw new AppError('NOT_FOUND')
    })).rejects.toBeInstanceOf(AppError)
    expect(business.statements.map(prefix)).toEqual(['begin', 'rollback'])
    expect(business.release).toHaveBeenCalledExactlyOnceWith(false)

    const unexpected = fakeClient()
    await expect(runnerWith(unexpected).readSnapshot(async () => {
      throw new Error('Query read timeout')
    })).rejects.toThrow('Query read timeout')
    expect(unexpected.release).toHaveBeenCalledExactlyOnceWith(true)

    const beginFails = fakeClient(['begin'])
    const work = vi.fn(async () => 1)
    await expect(runnerWith(beginFails).readSnapshot(work)).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
    expect(beginFails.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('没有登记开场核对（单元测试、只组装了部分模块的命令行）：只执行 work', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).readSnapshot(async (transaction) => {
      await select(transaction, 'work')
      return 'ok'
    })).resolves.toBe('ok')
    expect(client.statements).toEqual(['begin isolation level repeatable read read only', 'select \'work\'', 'commit'])
  })

  it('开场核对只能登记一次：再登记是接线错误，报错，不悄悄盖掉先登记的', () => {
    const runner = runnerWith(fakeClient())
    runner.registerSnapshotOpening(async () => {})
    expect(() => runner.registerSnapshotOpening(async () => {})).toThrow('只读快照的开场核对已经登记过')
  })

  it('一个请求只开一个快照：快照里再开快照或写事务直接报错，不另借连接（连接池满时会与外层互相等待）', async () => {
    const client = fakeClient()
    const pool = { connect: vi.fn(async () => client) }
    const runner = new TransactionRunner(pool as unknown as pg.Pool, new CommitLedger(), new SnapshotScope())
    await expect(runner.readSnapshot(async () => runner.readSnapshot(async () => 1))).rejects.toThrow(NESTED_IN_SNAPSHOT_MESSAGE)
    await expect(runner.readSnapshot(async () => runner.run(async () => 1))).rejects.toThrow(NESTED_IN_SNAPSHOT_MESSAGE)
    expect(pool.connect).toHaveBeenCalledTimes(2)
    // 快照结束之后照常
    await expect(runner.run(async () => 2)).resolves.toBe(2)
    await expect(runner.readSnapshot(async () => 3)).resolves.toBe(3)
  })

  it('"正在快照里"的标记是 database 模块共用的那一份（SnapshotScope，连接池据此拒绝查询）：开场核对与 work 里为真，快照之外、结束之后为假', async () => {
    const snapshots = new SnapshotScope()
    const runner = runnerWith(fakeClient(), new CommitLedger(), snapshots)
    const seen: Record<string, boolean | undefined> = {}
    runner.registerSnapshotOpening(async () => {
      seen.opening = snapshots.active()
    })
    let later: Promise<boolean> | undefined
    seen.before = snapshots.active()
    await runner.readSnapshot(async () => {
      seen.work = snapshots.active()
      // 快照里排下、结束之后才执行的操作
      later = new Promise(resolve => setTimeout(resolve, 0)).then(() => snapshots.active())
    })
    seen.after = snapshots.active()
    seen.later = await later
    expect(seen).toEqual({ before: false, opening: true, work: true, after: false, later: false })
  })

  it('业务错误、意外错误结束的快照同样结束标记', async () => {
    const snapshots = new SnapshotScope()
    let inside: Promise<boolean> | undefined
    await expect(runnerWith(fakeClient(), new CommitLedger(), snapshots).readSnapshot(async () => {
      inside = new Promise(resolve => setTimeout(resolve, 0)).then(() => snapshots.active())
      throw new AppError('NOT_FOUND')
    })).rejects.toBeInstanceOf(AppError)
    expect(await inside).toBe(false)
    await expect(runnerWith(fakeClient(), new CommitLedger(), snapshots).readSnapshot(async () => {
      inside = new Promise(resolve => setTimeout(resolve, 0)).then(() => snapshots.active())
      throw new Error('Query read timeout')
    })).rejects.toThrow('Query read timeout')
    expect(await inside).toBe(false)
  })

  it('快照里排下、快照结束之后才执行的事务（定时器、没有等的异步操作）不是嵌套：照常执行', async () => {
    const client = fakeClient()
    const pool = { connect: vi.fn(async () => client) }
    const runner = new TransactionRunner(pool as unknown as pg.Pool, new CommitLedger(), new SnapshotScope())
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let later: Promise<number> | undefined
    await runner.readSnapshot(async () => {
      later = released.then(async () => runner.run(async () => 4))
    })
    release()
    await expect(later).resolves.toBe(4)
  })
})
