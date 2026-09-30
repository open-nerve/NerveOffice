// 一轮清理的编排（M2-P4 设计 §3.4 第 6 条）：到期的才清、拿不到锁就跳过这一轮、单个失败不影响其他条目。
// 删除本身的语义（连带、审计、锁的顺序）在 documents 里，由它自己的单元测试与集成测试覆盖。
import type { AppConfig } from '../config/index.ts'
import type { ExclusiveRunner } from '../database/index.ts'
import type { ExpiredTrashEntry, TrashPurgeService } from '../documents/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { TRASH_PURGE_LOCK, TrashPurgeJob } from './trash-purge.job.ts'

const NOW = new Date('2026-10-28T03:00:00.000Z')

function entry(index: number, overrides: Partial<ExpiredTrashEntry> = {}): ExpiredTrashEntry {
  return {
    id: `0199a2c4-0000-7000-8000-00000000000${index}`,
    spaceId: '0199a2c4-0000-7000-8000-0000000000a1',
    kind: 'document',
    expiresAt: new Date('2026-09-28T03:00:00.000Z'),
    ...overrides,
  }
}

interface SetupOptions {
  /** 锁在别处（另一个实例正在清理） */
  held?: boolean
  expired?: ExpiredTrashEntry[]
  batchSize?: number
}

function setup(options: SetupOptions = {}) {
  const { held = false, expired = [], batchSize = 50 } = options
  const exclusive = {
    run: vi.fn(async <T>(_name: string, work: () => Promise<T>) => held ? { ran: false } : { ran: true, result: await work() }),
  }
  const trash = {
    listExpired: vi.fn(async (_now: Date, limit: number) => expired.slice(0, limit)),
    purgeExpired: vi.fn(async (target: ExpiredTrashEntry) => ({
      purged: true as const,
      outcome: { objectId: target.id, kind: target.kind, spaceId: target.spaceId, folders: 0, documents: 1, cascadedEntryIds: [] },
    })),
  }
  const config = { jobs: { trashPurge: { enabled: true, intervalMs: 3_600_000, batchSize } } } as AppConfig
  const error = vi.spyOn(AppLogger.prototype, 'error')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  return {
    exclusive,
    trash,
    error,
    job: new TrashPurgeJob(exclusive as unknown as ExclusiveRunner, trash as unknown as TrashPurgeService, config, logger),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TrashPurgeJob.runOnce', () => {
  it('取到期的一批：时刻由调用方给出（时钟），条数是配置的批量大小；逐个永久删除', async () => {
    const expired = [entry(1), entry(2, { kind: 'folder' })]
    const { job, trash, exclusive } = setup({ expired, batchSize: 20 })

    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, purged: 2, skipped: 0, failed: 0 })
    expect(exclusive.run).toHaveBeenCalledExactlyOnceWith(TRASH_PURGE_LOCK, expect.any(Function))
    expect(trash.listExpired).toHaveBeenCalledExactlyOnceWith(NOW, 20)
    // 逐个调用（各自一个短事务），顺序与取出来的一致
    expect(trash.purgeExpired.mock.calls.map(([target]) => target.id)).toEqual([expired[0]?.id, expired[1]?.id])
  })

  it('没有到期的东西：不调用清理', async () => {
    const { job, trash } = setup()
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, purged: 0, skipped: 0, failed: 0 })
    expect(trash.purgeExpired).not.toHaveBeenCalled()
  })

  it('锁在别处（另一个实例正在清理）：这一轮什么都不做，连到期的都不去查', async () => {
    const { job, trash } = setup({ held: true, expired: [entry(1)] })
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: false, purged: 0, skipped: 0, failed: 0 })
    expect(trash.listExpired).not.toHaveBeenCalled()
    expect(trash.purgeExpired).not.toHaveBeenCalled()
  })

  it('单个失败只记日志，这一轮的其他条目照常清理，runOnce 不抛出', async () => {
    const expired = [entry(1), entry(2), entry(3)]
    const { job, trash, error } = setup({ expired })
    const failure = new Error('永久删除时数据库报错')
    trash.purgeExpired.mockImplementationOnce(async target => ({ purged: true as const, outcome: { objectId: target.id, kind: target.kind, spaceId: target.spaceId, folders: 0, documents: 1, cascadedEntryIds: [] } }))
    trash.purgeExpired.mockImplementationOnce(async () => {
      throw failure
    })

    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, purged: 2, skipped: 0, failed: 1 })
    expect(trash.purgeExpired).toHaveBeenCalledTimes(3)
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('其他条目照常清理'), expect.objectContaining({ trashEntryId: expired[1]?.id, err: failure }))
  })

  it('锁下已经不在、或者刚被移到别的空间：算跳过，留给下一轮', async () => {
    const { job, trash } = setup({ expired: [entry(1), entry(2)] })
    trash.purgeExpired.mockImplementation(async () => ({ purged: false, reason: 'gone' }) as never)
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, purged: 0, skipped: 2, failed: 0 })
  })
})
