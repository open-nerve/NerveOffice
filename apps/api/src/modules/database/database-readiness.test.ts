import type pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { DatabaseReadiness, READINESS_CACHE_MS, READINESS_TIMEOUT_MS } from './database-readiness.ts'
import { readExpectedMigrations } from './migrations.ts'

const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())

/** 假的连接：按语句回答"记录表是否存在"与"已执行的迁移"。 */
function fakeClient(applied: { hash: string, created_at: string }[] | 'no-table' | Error) {
  return {
    release: vi.fn(),
    query: vi.fn(async (text: string) => {
      if (applied instanceof Error)
        throw applied
      if (text.includes('to_regclass'))
        return { rows: [{ exists: applied !== 'no-table' }] }
      return { rows: applied === 'no-table' ? [] : applied }
    }),
  }
}

function readinessWith(connect: () => Promise<unknown>) {
  const pool = { connect: vi.fn(connect) }
  return { pool, readiness: new DatabaseReadiness(pool as unknown as pg.Pool, logger) }
}

const APPLIED = readExpectedMigrations().map(migration => ({ hash: migration.hash, created_at: String(migration.when) }))

describe('DatabaseReadiness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('库结构一致：就绪，并归还连接', async () => {
    const client = fakeClient(APPLIED)
    const { readiness } = readinessWith(async () => client)
    expect(await readiness.check()).toEqual({ ready: true })
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('还没迁移：未就绪，说明待执行的个数', async () => {
    const { readiness } = readinessWith(async () => fakeClient('no-table'))
    expect(await readiness.check()).toEqual({ ready: false, reason: `库结构版本落后：待执行 ${APPLIED.length} 个迁移` })
  })

  it('连不上数据库：未就绪', async () => {
    const { readiness } = readinessWith(async () => Promise.reject(new Error('ECONNREFUSED')))
    expect(await readiness.check()).toEqual({ ready: false, reason: '数据库不可达' })
  })

  it('查询失败：未就绪，仍然归还连接', async () => {
    const client = fakeClient(new Error('查询出错'))
    const { readiness } = readinessWith(async () => client)
    expect(await readiness.check()).toEqual({ ready: false, reason: '数据库查询失败' })
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('检查超过时限：先回未就绪；后台的检查没结束之前不会再开一次', async () => {
    let finish: (client: unknown) => void = () => {}
    const { pool, readiness } = readinessWith(async () => new Promise((resolve) => {
      finish = resolve
    }))
    const first = readiness.check()
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS)
    expect(await first).toEqual({ ready: false, reason: `数据库检查超过 ${READINESS_TIMEOUT_MS} 毫秒` })

    await vi.advanceTimersByTimeAsync(READINESS_CACHE_MS)
    const second = readiness.check()
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS)
    await second
    expect(pool.connect).toHaveBeenCalledOnce()

    const client = fakeClient(APPLIED)
    finish(client)
    await vi.advanceTimersByTimeAsync(0)
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('并发的探针共享一次检查；结果缓存一秒', async () => {
    const { pool, readiness } = readinessWith(async () => fakeClient(APPLIED))
    await Promise.all([readiness.check(), readiness.check(), readiness.check()])
    await readiness.check()
    expect(pool.connect).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(READINESS_CACHE_MS)
    await readiness.check()
    expect(pool.connect).toHaveBeenCalledTimes(2)
  })
})
