import type { SnapshotMark } from './snapshot-scope.ts'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config/index.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { APPLICATION_NAME, createPool, KEEP_ALIVE_INITIAL_DELAY_MS, POOL_IN_SNAPSHOT_MESSAGE, refuseInsideSnapshot, SESSION_OPTIONS } from './pool.ts'
import { SnapshotScope } from './snapshot-scope.ts'

const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())

function settingsOf(env: Record<string, string> = {}) {
  return loadConfig({
    NERVE_DATABASE_URL: 'postgres://nerve:pw@127.0.0.1:1/nerve',
    NERVE_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    ...env,
  }).database
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createPool', () => {
  it('连接参数：超时取自配置，TCP keepalive 从空闲 10 秒开始探测，客户端侧的查询时限比语句超时多 5 秒（审查 A8、复验 N2）', async () => {
    const settings = settingsOf({ NERVE_DATABASE_STATEMENT_TIMEOUT_MS: '3000' })
    // 连接池按需建立连接：这里不会真的连接数据库
    const pool = createPool(settings, logger, new SnapshotScope())
    try {
      expect(pool.options).toMatchObject({
        max: settings.poolMax,
        connectionTimeoutMillis: settings.connectTimeoutMs,
        application_name: APPLICATION_NAME,
        statement_timeout: 3_000,
        lock_timeout: settings.lockTimeoutMs,
        idle_in_transaction_session_timeout: settings.idleInTransactionTimeoutMs,
        options: SESSION_OPTIONS,
        keepAlive: true,
        keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MS,
        query_timeout: 8_000,
      })
      expect(KEEP_ALIVE_INITIAL_DELAY_MS).toBe(10_000)
      // 会话的事务时限定为 0：库上的默认值不作数，要限时的事务自己设（M3-P5 复验 C1，真实数据库上的效果见 tests/integration 的 database/pool.test.ts）
      expect(SESSION_OPTIONS).toBe('-c transaction_timeout=0')
    }
    finally {
      await pool.end()
    }
  })

  it('建好的连接池已经接上快照的拒绝（M2 Codex 评审复验的必须修 1）：快照进行中查询、借连接被拒绝，不建连接；快照之外照常交给 pg', async () => {
    // 在建连接池之前替换 pg 自己的两个入口：连接池包装的就是它们，照常时调用到这里，不真的连接数据库
    const query = vi.spyOn(pg.Pool.prototype, 'query').mockResolvedValue({ rows: [{ via: 'pg' }] } as never)
    const connect = vi.spyOn(pg.Pool.prototype, 'connect').mockResolvedValue('client' as never)
    const snapshots = new SnapshotScope()
    const pool = createPool(settingsOf(), logger, snapshots)
    try {
      await snapshots.run({ open: true }, async () => {
        await expect(pool.query('SELECT 1')).rejects.toThrow(POOL_IN_SNAPSHOT_MESSAGE)
        await expect(pool.connect()).rejects.toThrow(POOL_IN_SNAPSHOT_MESSAGE)
      })
      expect([query.mock.calls.length, connect.mock.calls.length, pool.totalCount]).toEqual([0, 0, 0])

      await expect(pool.query('SELECT 1')).resolves.toEqual({ rows: [{ via: 'pg' }] })
      await expect(pool.connect()).resolves.toBe('client')
      expect(query).toHaveBeenCalledExactlyOnceWith('SELECT 1')
      expect(connect).toHaveBeenCalledOnce()
    }
    finally {
      vi.restoreAllMocks()
      await pool.end()
    }
  })
})

/** 假的连接池：两个入口记下调用，照常时交回各自的结果 */
function fakePool() {
  return {
    query: vi.fn(async (..._args: unknown[]) => 'rows'),
    connect: vi.fn(async (..._args: unknown[]) => 'client'),
  }
}

/** 包装之后的两个入口：按 pg 的写法调用（参数原样转交） */
function guardedPool(snapshots: SnapshotScope) {
  const pool = fakePool()
  const original = { query: pool.query, connect: pool.connect }
  refuseInsideSnapshot(pool as unknown as Parameters<typeof refuseInsideSnapshot>[0], snapshots)
  const call = pool as unknown as { query: (...args: unknown[]) => unknown, connect: (...args: unknown[]) => unknown }
  return { original, query: call.query, connect: call.connect }
}

describe('refuseInsideSnapshot：只读快照进行中，连接池上的查询与借连接一律报错（M2 Codex 评审复验的必须修 1，ADR-017）', () => {
  it('快照之外：参数原样转交给连接池，结果原样交回', async () => {
    const { original, query, connect } = guardedPool(new SnapshotScope())
    await expect(query({ text: 'select $1', values: [1] }, [1])).resolves.toBe('rows')
    await expect(connect()).resolves.toBe('client')
    expect(original.query).toHaveBeenCalledExactlyOnceWith({ text: 'select $1', values: [1] }, [1])
    expect(original.connect).toHaveBeenCalledOnce()
  })

  it('快照进行中：查询与借连接都返回被拒绝的 Promise（说明要传快照的事务），不交给连接池；不同步抛出', async () => {
    const snapshots = new SnapshotScope()
    const { original, query, connect } = guardedPool(snapshots)
    await snapshots.run({ open: true }, async () => {
      const queried = query('select 1')
      const borrowed = connect()
      await expect(queried).rejects.toThrow(POOL_IN_SNAPSHOT_MESSAGE)
      await expect(borrowed).rejects.toThrow(POOL_IN_SNAPSHOT_MESSAGE)
    })
    expect(original.query).not.toHaveBeenCalled()
    expect(original.connect).not.toHaveBeenCalled()
  })

  it('快照进行中、带回调的写法（pg 的另一种约定）：错误经回调交回，不返回 Promise、不同步抛出', async () => {
    const snapshots = new SnapshotScope()
    const { original, query, connect } = guardedPool(snapshots)
    const errors = await snapshots.run({ open: true }, async () => {
      const queried = new Promise<unknown>((resolve) => {
        expect(query('select 1', [], resolve)).toBeUndefined()
      })
      const borrowed = new Promise<unknown>((resolve) => {
        expect(connect(resolve)).toBeUndefined()
      })
      return Promise.all([queried, borrowed])
    })
    expect(errors.map(error => (error as Error).message)).toEqual([POOL_IN_SNAPSHOT_MESSAGE, POOL_IN_SNAPSHOT_MESSAGE])
    expect(original.query).not.toHaveBeenCalled()
    expect(original.connect).not.toHaveBeenCalled()
  })

  it('快照结束之后（快照里排下、结束之后才执行的操作）照常', async () => {
    const snapshots = new SnapshotScope()
    const { original, query } = guardedPool(snapshots)
    const mark: SnapshotMark = { open: true }
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const later = snapshots.run(mark, async () => released.then(async () => query('select later')))
    mark.open = false
    release()
    await expect(later).resolves.toBe('rows')
    expect(original.query).toHaveBeenCalledExactlyOnceWith('select later')
  })
})
