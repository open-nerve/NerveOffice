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
  /** 到期的条目，最早到期的在前；用例可以之后再改它（模拟有人恢复或永久删除了其中一个） */
  expired?: ExpiredTrashEntry[]
  batchSize?: number
  /** 两轮之间的间隔：暂缓的上限按它折算成轮数 */
  intervalMs?: number
}

function setup(options: SetupOptions = {}) {
  const { held = false, expired = [], batchSize = 50, intervalMs = 3_600_000 } = options
  const exclusive = {
    run: vi.fn(async <T>(_name: string, work: () => Promise<T>) => held ? { ran: false } : { ran: true, result: await work() }),
  }
  const trash = {
    // 与真实的仓储一样：让开 except 里的，再取最早到期的 limit 个
    listExpired: vi.fn(async (_now: Date, limit: number, except: readonly string[] = []) => expired.filter(row => !except.includes(row.id)).slice(0, limit)),
    purgeExpired: vi.fn(async (target: ExpiredTrashEntry) => ({
      purged: true as const,
      outcome: { objectId: target.id, kind: target.kind, spaceId: target.spaceId, folders: 0, documents: 1, cascadedEntryIds: [] },
    })),
  }
  const config = { jobs: { trashPurge: { enabled: true, intervalMs, batchSize } } } as AppConfig
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
    // 没有失败过的条目，不必让开谁
    expect(trash.listExpired).toHaveBeenCalledExactlyOnceWith(NOW, 20, [])
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

describe('TrashPurgeJob 作为定时任务（JobScheduler 排程）', () => {
  it('名字、开关与间隔取自配置；启动日志另带一批的数量；关掉时说明到期的要人工永久删除', () => {
    const { job } = setup({ batchSize: 20, intervalMs: 900_000 })
    expect(job.name).toBe('trash-purge')
    expect(job.title).toBe('回收站的自动清理')
    expect(job.schedule).toEqual({ enabled: true, intervalMs: 900_000 })
    expect(job.settings).toEqual({ batchSize: 20 })
    expect(job.disabled).toEqual({ variable: 'NERVE_TRASH_PURGE_ENABLED', consequence: '到期的东西要人工永久删除' })
  })
})

/** 让这些条目每次永久删除都失败（例如数据不一致），别的照常清掉 */
function alwaysFailing(trash: ReturnType<typeof setup>['trash'], ids: readonly string[]): void {
  trash.purgeExpired.mockImplementation(async (target: ExpiredTrashEntry) => {
    if (ids.includes(target.id))
      throw new Error('永久删除时数据库报错')
    return { purged: true as const, outcome: { objectId: target.id, kind: target.kind, spaceId: target.spaceId, folders: 0, documents: 1, cascadedEntryIds: [] } }
  })
}

/** 连续跑 rounds 轮，记下每一轮试过哪些条目 */
async function attemptsOver(job: TrashPurgeJob, trash: ReturnType<typeof setup>['trash'], rounds: number): Promise<string[][]> {
  const attempts: string[][] = []
  for (let round = 0; round < rounds; round += 1) {
    const before = trash.purgeExpired.mock.calls.length
    await job.runOnce(NOW)
    attempts.push(trash.purgeExpired.mock.calls.slice(before).map(([target]) => target.id))
  }
  return attempts
}

/** 失败日志里的字段（按失败的先后） */
function failureFields(error: ReturnType<typeof setup>['error']): Record<string, unknown>[] {
  return error.mock.calls.map(([, fields]) => fields as Record<string, unknown>)
}

describe('一直失败的条目暂缓重试，不挡住后面到期的（M2-P6 复核 A 的 S-1、B 的 G2）', () => {
  it('最早到期的两单一直失败（批量 2）：下一轮取批时让开它们，后面到期的照常清掉', async () => {
    const [first, second, later] = [entry(1), entry(2), entry(3)]
    const { job, trash } = setup({ expired: [first, second, later], batchSize: 2 })
    alwaysFailing(trash, [first.id, second.id])

    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, purged: 0, skipped: 0, failed: 2 })
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, purged: 1, skipped: 0, failed: 0 })
    expect(trash.listExpired.mock.calls.map(([, limit, except]) => [limit, except])).toEqual([[2, []], [2, [first.id, second.id]]])
    expect(trash.purgeExpired.mock.calls.map(([target]) => target.id)).toEqual([first.id, second.id, later.id])
  })

  it('连续失败 n 次就让开之后的 2^(n-1) 轮；失败日志带着连续失败的次数（将来据此告警）', async () => {
    const failing = entry(1)
    const { job, trash, error } = setup({ expired: [failing] })
    alwaysFailing(trash, [failing.id])

    // 第 1 轮失败，让开 1 轮；第 3 轮再失败，让开 2 轮；第 6 轮，让开 4 轮；第 11 轮……
    const attempts = await attemptsOver(job, trash, 11)
    expect(attempts.flatMap((ids, round) => ids.length > 0 ? [round + 1] : [])).toEqual([1, 3, 6, 11])
    expect(failureFields(error).map(fields => [fields.trashEntryId, fields.consecutiveFailures, fields.deferredRounds])).toEqual([
      [failing.id, 1, 1],
      [failing.id, 2, 2],
      [failing.id, 3, 4],
      [failing.id, 4, 8],
    ])
  })

  it('最多让开约一天：按两轮之间的间隔折算成轮数，至少一轮', async () => {
    const failing = entry(1)
    // 间隔 6 小时：一天是 4 轮
    const sixHours = setup({ expired: [failing], intervalMs: 6 * 3_600_000 })
    alwaysFailing(sixHours.trash, [failing.id])
    // 第 1、3、6、11 轮试过：之后让开的轮数是 1、2、4、4（不再翻倍）
    const attempts = await attemptsOver(sixHours.job, sixHours.trash, 15)
    expect(attempts.flatMap((ids, round) => ids.length > 0 ? [round + 1] : [])).toEqual([1, 3, 6, 11])
    expect(failureFields(sixHours.error).map(fields => fields.deferredRounds)).toEqual([1, 2, 4, 4])
    vi.restoreAllMocks()

    // 间隔就是一天：每次失败都只让开一轮
    const daily = setup({ expired: [failing], intervalMs: 86_400_000 })
    alwaysFailing(daily.trash, [failing.id])
    const dailyAttempts = await attemptsOver(daily.job, daily.trash, 6)
    expect(dailyAttempts.map(ids => ids.length)).toEqual([1, 0, 1, 0, 1, 0])
    expect(failureFields(daily.error).map(fields => [fields.consecutiveFailures, fields.deferredRounds])).toEqual([[1, 1], [2, 1], [3, 1]])
  })

  it('清掉了或者跳过了就忘掉：之后再失败从 1 算起', async () => {
    const flaky = entry(1)
    const { job, trash, error } = setup({ expired: [flaky] })
    alwaysFailing(trash, [flaky.id])
    await job.runOnce(NOW)
    await job.runOnce(NOW)
    // 第 3 轮：锁下看到它刚被移到别的空间，跳过（不是失败）
    trash.purgeExpired.mockImplementationOnce(async () => ({ purged: false, reason: 'moved' }) as never)
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, purged: 0, skipped: 1, failed: 0 })
    // 第 4 轮又失败：连续失败的次数从 1 算起，只让开 1 轮
    await expect(job.runOnce(NOW)).resolves.toMatchObject({ failed: 1 })
    expect(failureFields(error).map(fields => fields.consecutiveFailures)).toEqual([1, 1])
    expect(trash.listExpired.mock.calls.at(-1)?.[2]).toEqual([])
  })

  it('不在回收站里了（被人恢复或永久删除）就忘掉，记着的条目不会越攒越多；一批取满时判断不了，先留着', async () => {
    const [gone, other] = [entry(1), entry(2)]
    const expired = [gone, other]
    const { job, trash, error } = setup({ expired, batchSize: 1 })
    alwaysFailing(trash, [gone.id, other.id])
    await job.runOnce(NOW)
    // 第 2 轮：gone 在让开之列，取到的是 other（取满了一批），也失败
    await job.runOnce(NOW)
    expect(failureFields(error).map(fields => [fields.trashEntryId, fields.consecutiveFailures])).toEqual([[gone.id, 1], [other.id, 1]])
    // gone 被人永久删除了；第 3 轮 other 在让开之列、gone 不在了：这一批没有取满，gone 就被忘掉
    expired.splice(0, 1)
    await expect(job.runOnce(NOW)).resolves.toEqual({ ran: true, purged: 0, skipped: 0, failed: 0 })
    // 回头看：同一个 id 再出现（只为观察记忆里还有没有它），第 4 轮取到它、又失败，连续失败从 1 算起——说明它确实被忘掉了
    expired.unshift(gone)
    await job.runOnce(NOW)
    expect(failureFields(error).at(-1)).toMatchObject({ trashEntryId: gone.id, consecutiveFailures: 1 })

    // 对照：一批取满时不忘。第 4 轮 other 已经不在让开之列，却因为这一批被 gone 取满而没有出现在批里，它仍然记着：
    // 第 5 轮取到它、又失败，连续失败是 2
    await job.runOnce(NOW)
    expect(failureFields(error).filter(fields => fields.trashEntryId === other.id).map(fields => fields.consecutiveFailures)).toEqual([1, 2])
  })
})
