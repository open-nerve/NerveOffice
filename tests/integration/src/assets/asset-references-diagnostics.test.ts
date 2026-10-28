import type { Database } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import process from 'node:process'
import { inspect } from 'node:util'
import { TransactionRunner } from '@nerve-office/api'
import { DrizzleQueryError, sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { bulkReferenceStage, bulkReferenceTransaction } from './asset-references-bulk.test-support.ts'

const PARAMETER_MARKER = 'bulk-diagnostic-parameter-must-not-escape'
let database: TestDatabase
let app: TestApp
beforeAll(async () => {
  database = await createTestDatabase()
  // 只在诊断自身的小回归里制造真实取消；原七万资源用例保持默认数据库配置。
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_DATABASE_STATEMENT_TIMEOUT_MS: '100' } })
})
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function rejected(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
  }
  catch (error) {
    return error
  }
  throw new Error('诊断回归的数据库语句意外成功')
}

/** 覆盖 Vitest 可观察到的消息、堆栈、自有字段与 cause，断言失败也不回显原错误。 */
function formatted(error: unknown): string {
  return [String(error), error instanceof Error ? error.stack : '', JSON.stringify(error), inspect(error, { depth: 10 })].join('\n')
}

it('真实 PostgreSQL 57014 经 Drizzle 包装后仍有 SQLSTATE、阶段、计数和调用位置，参数不进入格式化错误', async () => {
  let original: unknown
  const error = await rejected(async () => bulkReferenceStage('replace', 70_000, async () => {
    try {
      await app.runtime.get(TransactionRunner).run(async (transaction) => {
        await (transaction as unknown as Database).execute(sql`SELECT pg_sleep(0.3), ${PARAMETER_MARKER}::text`)
      })
    }
    catch (caught) {
      original = caught
      throw caught
    }
  }))
  expect(original instanceof DrizzleQueryError).toBe(true)
  expect((original as DrizzleQueryError).cause).toBeInstanceOf(pg.DatabaseError)
  expect(((original as DrizzleQueryError).cause as pg.DatabaseError).code).toBe('57014')
  const text = formatted(error)
  expect(text.includes(PARAMETER_MARKER)).toBe(false)
  expect(error === original).toBe(false)
  expect(text.includes('57014')).toBe(true)
  expect(text.includes('replace')).toBe(true)
  expect(text.includes('70000')).toBe(true)
  expect(text.includes('elapsedMs')).toBe(true)
  expect(text.includes('asset-references-diagnostics.test.ts')).toBe(true)
  expect(text.length).toBeLessThan(65_536)
})

it('真实 PostgreSQL 23505 的 detail、Drizzle params 与错误消息里的绑定值都不逃逸，约束和原因保留', async () => {
  const error = await rejected(async () => bulkReferenceStage('fixture', 1, async () => app.runtime.get(TransactionRunner).run(async (transaction) => {
    const executor = transaction as unknown as Database
    await executor.execute(sql`CREATE TEMP TABLE bulk_diagnostic_unique (value text CONSTRAINT bulk_diagnostic_unique_key UNIQUE) ON COMMIT DROP`)
    await executor.execute(sql`INSERT INTO bulk_diagnostic_unique (value) VALUES (${PARAMETER_MARKER})`)
    await executor.execute(sql`INSERT INTO bulk_diagnostic_unique (value) VALUES (${PARAMETER_MARKER})`)
  })))
  const text = formatted(error)
  expect(text.includes(PARAMETER_MARKER)).toBe(false)
  expect(text.includes('23505')).toBe(true)
  expect(text.includes('bulk_diagnostic_unique_key')).toBe(true)
  expect(text.includes('paramCount')).toBe(true)
})

it('事务内阶段保留真实数据库错误对象，事务完成原有回滚处置后才转换为安全诊断', async () => {
  let queryError: unknown
  let seenInsideTransaction: unknown
  let seenAfterTransaction: unknown
  const error = await rejected(async () => bulkReferenceTransaction(70_000, async (stage) => {
    try {
      return await app.runtime.get(TransactionRunner).run(async (transaction) => {
        try {
          await stage('replace', async () => {
            try {
              await (transaction as unknown as Database).execute(sql`SELECT pg_sleep(0.3), ${PARAMETER_MARKER}::text`)
            }
            catch (caught) {
              queryError = caught
              throw caught
            }
          })
        }
        catch (caught) {
          seenInsideTransaction = caught
          throw caught
        }
      })
    }
    catch (caught) {
      seenAfterTransaction = caught
      throw caught
    }
  }))
  expect(queryError instanceof DrizzleQueryError).toBe(true)
  expect(seenInsideTransaction === queryError).toBe(true)
  expect(seenAfterTransaction === queryError).toBe(true)
  expect(error === queryError).toBe(false)
  expect(formatted(error).includes(PARAMETER_MARKER)).toBe(false)
  expect(formatted(error).includes('57014')).toBe(true)
})

it('真实查询取消后再终止本测试连接使回滚失败，事务原有规则仍保留57014而不是诊断或回滚错误', async () => {
  let queryError: unknown
  let seenAfterTransaction: unknown
  let terminated = false
  const error = await rejected(async () => bulkReferenceTransaction(70_000, async (stage) => {
    try {
      return await app.runtime.get(TransactionRunner).run(async (transaction) => {
        const executor = transaction as unknown as Database
        const pid = (await executor.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid
        try {
          await stage('replace', async () => {
            try {
              await executor.execute(sql`SELECT pg_sleep(0.3), ${PARAMETER_MARKER}::text`)
            }
            catch (caught) {
              queryError = caught
              throw caught
            }
          })
        }
        catch (caught) {
          // 只终止刚由本测试借出的连接，真实触发随后 ROLLBACK 的连接失败。
          terminated = await database.query(async client => (await client.query<{ terminated: boolean }>('SELECT pg_terminate_backend($1) AS terminated', [pid])).rows[0]!.terminated)
          throw caught
        }
      })
    }
    catch (caught) {
      seenAfterTransaction = caught
      throw caught
    }
  }))
  expect(terminated).toBe(true)
  expect(queryError instanceof DrizzleQueryError).toBe(true)
  expect(seenAfterTransaction === queryError).toBe(true)
  expect(error === queryError).toBe(false)
  expect(formatted(error).includes('57014')).toBe(true)
  expect(formatted(error).includes(PARAMETER_MARKER)).toBe(false)
})

it('成功保留返回值，并只输出固定阶段、计数、耗时及成功状态', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    const value = { exact: 'returned-object' }
    expect(await bulkReferenceStage('read-back', 7, async () => value)).toBe(value)
    expect(output.mock.calls.length).toBe(1)
    const entry = JSON.parse(String(output.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(entry).toMatchObject({ event: 'bulk-reference-stage', stage: 'read-back', assetCount: 7, status: 'passed' })
    expect(typeof entry.elapsedMs).toBe('number')
    expect(Number.isFinite(entry.elapsedMs)).toBe(true)
    expect(entry.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(Object.keys(entry).sort()).toEqual(['assetCount', 'elapsedMs', 'event', 'stage', 'status'])
  }
  finally {
    output.mockRestore()
  }
})

it('非数据库断言及非 Error 抛出值仍是原对象，不能把产品断言改写成数据库诊断', async () => {
  const assertion = await rejected(async () => expect(1).toBe(2))
  expect(await rejected(async () => bulkReferenceStage('authorize', 7, async () => {
    throw assertion
  }))).toBe(assertion)
  const plain = { code: 'EXAMPLE', message: 'plain failure' }
  expect(await rejected(async () => bulkReferenceStage('authorize', 7, async () => {
    throw plain
  }))).toBe(plain)
})

it('识别到 Drizzle 后也不复制未知 cause 的消息、自有秘密字段和后代原对象', async () => {
  const cause = Object.assign(new Error(PARAMETER_MARKER), { responseBody: PARAMETER_MARKER, params: [PARAMETER_MARKER] })
  const original = new DrizzleQueryError('SELECT $1', [PARAMETER_MARKER], cause)
  const error = await rejected(async () => bulkReferenceStage('prepare', 1, async () => {
    throw original
  }))
  const text = formatted(error)
  expect(text.includes(PARAMETER_MARKER)).toBe(false)
  expect(text.includes('DrizzleQueryError')).toBe(true)
  expect(text.includes('SELECT $1')).toBe(true)
  expect(text.includes('asset-references-diagnostics.test.ts')).toBe(true)
})

it('参数里的换行伪调用帧不能被作为真实 stack 带入诊断', async () => {
  const original = new DrizzleQueryError('SELECT $1', [`\n    at ${PARAMETER_MARKER}\n`], new Error('driver failure'))
  const error = await rejected(async () => bulkReferenceStage('replace', 1, async () => {
    throw original
  }))
  expect(formatted(error).includes(PARAMETER_MARKER)).toBe(false)
  expect(formatted(error).includes('asset-references-diagnostics.test.ts')).toBe(true)
})

it.each(['DatabaseError', 'DrizzleQueryError'] as const)('未知 cause 冒充 %s 名称仍不能把自己的 schema 或 query 升级成数据库诊断', async (name) => {
  const cause = Object.assign(new Error('unknown driver failure'), {
    name,
    schema: PARAMETER_MARKER,
    query: PARAMETER_MARKER,
  })
  const original = new DrizzleQueryError('SELECT $1', [PARAMETER_MARKER], cause)
  const error = await rejected(async () => bulkReferenceStage('replace', 1, async () => {
    throw original
  }))
  const text = formatted(error)
  expect(text.includes(PARAMETER_MARKER)).toBe(false)
  expect(text.includes('UnrecognizedDatabaseCause')).toBe(true)
  expect(text.includes('SELECT $1')).toBe(true)
})

it('超长 SQL、循环与过深原因链仍有界且不会重新挂载原数据库异常', async () => {
  let cause = new DrizzleQueryError('SELECT $1', [PARAMETER_MARKER], new Error(PARAMETER_MARKER))
  cause.cause = cause
  for (let index = 0; index < 8; index += 1)
    cause = new DrizzleQueryError(`SELECT $1 ${' '.repeat(10_000)}`, [PARAMETER_MARKER], cause)
  const error = await rejected(async () => bulkReferenceStage('replace', 70_000, async () => {
    throw cause
  }))
  const text = formatted(error)
  expect(text.includes(PARAMETER_MARKER)).toBe(false)
  expect(text.length).toBeLessThan(65_536)
  expect(error === cause).toBe(false)
})

it.each(['throwing-getter', 'non-string-stack'] as const)('诊断构造遇未知 cause 的 %s 仍保留 SQLSTATE，不能泄露或覆盖真实数据库失败', async (kind) => {
  const cause = kind === 'throwing-getter'
    ? new Error(PARAMETER_MARKER)
    : Object.assign(new pg.DatabaseError(PARAMETER_MARKER, 0, 'error'), { code: '23505', severity: 'ERROR' })
  if (kind === 'throwing-getter') {
    Object.defineProperty(cause, 'privatePayload', { enumerable: true, get: () => {
      throw new Error(PARAMETER_MARKER)
    } })
  }
  else {
    Object.defineProperty(cause, 'stack', { value: 123 })
  }
  const original = Object.assign(new pg.DatabaseError('controlled database failure', 0, 'error'), { code: '57014', severity: 'ERROR', cause })
  const error = await rejected(async () => bulkReferenceStage('replace', 1, async () => {
    throw original
  }))
  const text = formatted(error)
  expect(text.includes(PARAMETER_MARKER)).toBe(false)
  expect(text.includes('57014')).toBe(true)
  expect(text.includes('diagnostic-incomplete')).toBe(true)
  expect(error === original).toBe(false)
})
