import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ExclusiveRunner } from './exclusive-runner.ts'

const LOCK = 'nerve-office:trash-purge'

interface FakeOptions {
  /** 取锁的结果；默认拿得到 */
  locked?: boolean
  /** 释放锁的结果；默认释放成功 */
  unlocked?: boolean
  /** 释放锁时报错 */
  unlockFails?: boolean
}

/** 假的连接：记下执行过的语句（按函数名）与参数；取锁与释放的结果由用例给定。 */
function fakeClient(options: FakeOptions = {}) {
  const { locked = true, unlocked = true, unlockFails = false } = options
  const calls: { name: string, values: unknown[] }[] = []
  return {
    calls,
    release: vi.fn(),
    getTransactionStatus: vi.fn((): 'I' | 'T' | 'E' => 'I'),
    query: vi.fn(async (text: string, values: unknown[]) => {
      const isLock = text.includes('pg_try_advisory_lock')
      calls.push({ name: isLock ? 'lock' : 'unlock', values })
      if (!isLock && unlockFails)
        throw new Error('释放锁失败')
      return { rows: [isLock ? { locked } : { unlocked }], rowCount: 1, command: '', fields: [] }
    }),
  }
}

function runnerWith(client: ReturnType<typeof fakeClient>): ExclusiveRunner {
  const pool = { connect: vi.fn(async () => client) }
  return new ExclusiveRunner(pool as unknown as pg.Pool)
}

describe('ExclusiveRunner', () => {
  it('拿到锁：在同一个连接上取锁、执行、释放，连接照常放回', async () => {
    const client = fakeClient()
    const work = vi.fn(async () => 42)
    await expect(runnerWith(client).run(LOCK, work)).resolves.toEqual({ ran: true, result: 42 })
    expect(work).toHaveBeenCalledTimes(1)
    expect(client.calls).toEqual([{ name: 'lock', values: [LOCK] }, { name: 'unlock', values: [LOCK] }])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('锁在别处：不执行，也不发释放的语句，连接照常放回', async () => {
    const client = fakeClient({ locked: false })
    const work = vi.fn(async () => 42)
    await expect(runnerWith(client).run(LOCK, work)).resolves.toEqual({ ran: false })
    expect(work).not.toHaveBeenCalled()
    expect(client.calls.map(call => call.name)).toEqual(['lock'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('work 抛出：先释放锁，再把原来的错误抛给调用方，连接丢弃', async () => {
    const client = fakeClient()
    const failing = runnerWith(client).run(LOCK, async () => {
      throw new Error('一轮跑砸了')
    })
    await expect(failing).rejects.toThrow('一轮跑砸了')
    expect(client.calls.map(call => call.name)).toEqual(['lock', 'unlock'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('释放失败时丢弃连接：会话结束，数据库随即释放这把锁', async () => {
    const failed = fakeClient({ unlockFails: true })
    await expect(runnerWith(failed).run(LOCK, async () => 1)).resolves.toEqual({ ran: true, result: 1 })
    expect(failed.release).toHaveBeenCalledExactlyOnceWith(true)

    // 数据库说这个会话并没有持有它（不该发生）时同样丢弃
    const notHeld = fakeClient({ unlocked: false })
    await expect(runnerWith(notHeld).run(LOCK, async () => 1)).resolves.toEqual({ ran: true, result: 1 })
    expect(notHeld.release).toHaveBeenCalledExactlyOnceWith(true)
  })
})
