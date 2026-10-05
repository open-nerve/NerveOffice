// 修订记录与回执的保留期清理的一轮（M3-P3 设计 §3.9）：分批删到不满一批为止、每批一个带事务级锁的事务、拿不到锁就停下这一轮、
// 退出时做完手上这一批就停、一批失败记日志不抛出。什么算过期（早于保留期、不是当前修订）在 documents 里，由它的测试与集成测试覆盖。
import type { AppConfig } from '../config/index.ts'
import type { ExclusiveRunner, Transaction } from '../database/index.ts'
import type { PurgedRecords, RevisionPurgeService } from '../documents/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { REVISION_PURGE_LOCK, RevisionPurgeJob } from './revision-purge.job.ts'

const NOW = new Date('2026-11-04T03:00:00.000Z')
/** 每一批的事务（假的）：核对 documents 拿到的就是持着锁的那个事务 */
const TRANSACTION = { batch: 'transaction' } as unknown as Transaction

interface SetupOptions {
  /** 每一批删掉的条数，按顺序；用完之后都是 0 */
  batches?: readonly PurgedRecords[]
  /** 第几批（从 0 起）拿不到锁 */
  heldAt?: number
  batchSize?: number
}

function setup(options: SetupOptions = {}) {
  const { batches = [], heldAt, batchSize = 2 } = options
  let attempt = 0
  const exclusive = {
    runTransaction: vi.fn(async <T>(_name: string, work: (transaction: Transaction) => Promise<T>) => {
      const index = attempt
      attempt += 1
      return index === heldAt ? { ran: false } : { ran: true, result: await work(TRANSACTION) }
    }),
  }
  let call = 0
  const purge = {
    purgeExpired: vi.fn(async (_now: Date, _limit: number, _transaction: Transaction): Promise<PurgedRecords> => {
      const result = batches[call] ?? { revisions: 0, receipts: 0 }
      call += 1
      return result
    }),
  }
  const config = { jobs: { revisionPurge: { enabled: true, intervalMs: 3_600_000, batchSize } }, revisions: { retentionDays: 30 } } as AppConfig
  const info = vi.spyOn(AppLogger.prototype, 'info')
  const error = vi.spyOn(AppLogger.prototype, 'error')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  return {
    exclusive,
    purge,
    info,
    error,
    job: new RevisionPurgeJob(exclusive as unknown as ExclusiveRunner, purge as unknown as RevisionPurgeService, config, logger),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RevisionPurgeJob.runOnce', () => {
  it('每一批在一个取了事务级锁的事务里：时刻由调用方给出（时钟），条数是配置的一批；不满一批就删完了', async () => {
    const { job, exclusive, purge } = setup({ batches: [{ revisions: 1, receipts: 0 }], batchSize: 20 })
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, revisions: 1, receipts: 0, batches: 1, ending: 'drained' })
    expect(exclusive.runTransaction).toHaveBeenCalledExactlyOnceWith(REVISION_PURGE_LOCK, expect.any(Function))
    expect(purge.purgeExpired).toHaveBeenCalledExactlyOnceWith(NOW, 20, TRANSACTION)
  })

  it('一批满了就接着删下一批（修订记录或回执哪一样满了都算），直到两样都不满一批', async () => {
    const { job, purge } = setup({
      batches: [{ revisions: 2, receipts: 2 }, { revisions: 2, receipts: 0 }, { revisions: 0, receipts: 1 }],
    })
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, revisions: 4, receipts: 3, batches: 3, ending: 'drained' })
    expect(purge.purgeExpired).toHaveBeenCalledTimes(3)
  })

  it('只有回执满了一批：同样接着删', async () => {
    const { job } = setup({ batches: [{ revisions: 0, receipts: 2 }, { revisions: 0, receipts: 0 }] })
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, revisions: 0, receipts: 2, batches: 2, ending: 'drained' })
  })

  it('没有过期的东西：跑一批（一个短事务）就结束', async () => {
    const { job, purge, info } = setup()
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, revisions: 0, receipts: 0, batches: 1, ending: 'drained' })
    expect(purge.purgeExpired).toHaveBeenCalledOnce()
    // 什么也没删时不记 info
    expect(info).not.toHaveBeenCalled()
  })

  it('第一批就拿不到锁（另一个实例正在清理）：这一轮什么都不做', async () => {
    const { job, purge } = setup({ heldAt: 0, batches: [{ revisions: 2, receipts: 0 }] })
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: false, revisions: 0, receipts: 0, batches: 0, ending: 'contended' })
    expect(purge.purgeExpired).not.toHaveBeenCalled()
  })

  it('中途某一批拿不到锁：停下这一轮，余下的留给那个实例', async () => {
    const { job, purge } = setup({ heldAt: 1, batches: [{ revisions: 2, receipts: 0 }, { revisions: 2, receipts: 0 }] })
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, revisions: 2, receipts: 0, batches: 1, ending: 'contended' })
    expect(purge.purgeExpired).toHaveBeenCalledOnce()
  })

  it('退出（signal 中止）：做完手上这一批就停，余下的留给下一轮', async () => {
    const controller = new AbortController()
    const { job, purge } = setup({ batches: [{ revisions: 2, receipts: 0 }, { revisions: 2, receipts: 0 }, { revisions: 1, receipts: 0 }] })
    purge.purgeExpired.mockImplementationOnce(async () => {
      // 这一批还在删的时候应用开始退出
      controller.abort()
      return { revisions: 2, receipts: 0 }
    })
    await expect(job.runOnce(NOW, controller.signal)).resolves.toEqual({ ran: true, revisions: 2, receipts: 0, batches: 1, ending: 'stopped' })
    expect(purge.purgeExpired).toHaveBeenCalledOnce()
  })

  it('已经删完的一批不因为退出而算作停下：最后一批不满时照常是 drained', async () => {
    const controller = new AbortController()
    controller.abort()
    const { job } = setup({ batches: [{ revisions: 1, receipts: 0 }] })
    await expect(job.runOnce(NOW, controller.signal)).resolves.toEqual({ ran: true, revisions: 1, receipts: 0, batches: 1, ending: 'drained' })
  })

  it('一批失败（这一批回滚）：记日志（带着已经删了多少），这一轮到此为止，不抛给调度器；下一轮照常', async () => {
    const { job, purge, error } = setup({ batches: [{ revisions: 2, receipts: 1 }] })
    const failure = new Error('语句超时')
    purge.purgeExpired.mockImplementationOnce(async () => ({ revisions: 2, receipts: 1 }))
    purge.purgeExpired.mockImplementationOnce(async () => {
      throw failure
    })
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, revisions: 2, receipts: 1, batches: 1, ending: 'failed' })
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('这一轮到此为止'), { revisions: 2, receipts: 1, batches: 1, err: failure })
    // 下一轮照常
    await expect(job.runOnce(NOW)).resolves.toMatchObject({ ran: true, ending: 'drained' })
  })

  it('取锁本身失败（例如连接断了）同样按失败记下、不抛出', async () => {
    const { job, exclusive, error } = setup()
    exclusive.runTransaction.mockRejectedValueOnce(new Error('连接断了'))
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, revisions: 0, receipts: 0, batches: 0, ending: 'failed' })
    expect(error).toHaveBeenCalledOnce()
  })

  it('删了东西时一轮一条 info：每样删了几条、几批、怎样结束的', async () => {
    const { job, info } = setup({ batches: [{ revisions: 2, receipts: 1 }, { revisions: 1, receipts: 0 }] })
    await job.runOnce(NOW)
    expect(info).toHaveBeenCalledExactlyOnceWith('删掉了过了保留期的修订记录与回执', { revisions: 3, receipts: 1, batches: 2, ending: 'drained' })
  })
})

describe('RevisionPurgeJob 作为定时任务', () => {
  it('名字、开关与间隔取自配置；启动日志另带一批的数量与保留天数；关掉时说明过期的留着', () => {
    const { job } = setup({ batchSize: 1_000 })
    expect(job.name).toBe('revision-purge')
    expect(job.schedule).toEqual({ enabled: true, intervalMs: 3_600_000 })
    expect(job.settings).toEqual({ batchSize: 1_000, retentionDays: 30 })
    expect(job.disabled.variable).toBe('NERVE_REVISION_PURGE_ENABLED')
    expect(job.disabled.consequence).toContain('留着')
  })
})
