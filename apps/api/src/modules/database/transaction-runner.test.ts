import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { TransactionRunner } from './transaction-runner.ts'

/** 假的连接：记下执行过的语句；以 failOn 里的某一项开头的语句执行时报错。 */
function fakeClient(failOn: readonly string[] = []) {
  const statements: string[] = []
  return {
    statements,
    release: vi.fn(),
    query: vi.fn(async (config: { text: string }) => {
      statements.push(config.text)
      if (failOn.some(prefix => config.text.startsWith(prefix)))
        throw new Error(`${prefix(config.text)} 失败`)
      return { rows: [], rowCount: 0, command: '', fields: [] }
    }),
  }
}

function prefix(text: string): string {
  return text.split(' ')[0] ?? text
}

function runnerWith(client: ReturnType<typeof fakeClient>): TransactionRunner {
  const pool = { connect: vi.fn(async () => client) }
  return new TransactionRunner(pool as unknown as pg.Pool)
}

describe('TransactionRunner', () => {
  it('work 正常结束：提交，连接照常放回', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).run(async () => 42)).resolves.toBe(42)
    expect(client.statements.map(prefix)).toEqual(['begin', 'commit'])
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

  it('取不到连接：直接抛出，没有要归还的连接', async () => {
    const pool = { connect: vi.fn(async () => {
      throw new Error('timeout exceeded when trying to connect')
    }) }
    await expect(new TransactionRunner(pool as unknown as pg.Pool).run(async () => 1)).rejects.toThrow('timeout exceeded')
  })
})
