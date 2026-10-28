import process from 'node:process'
import { framesOnly, serializeError } from '@nerve-office/api/testing'
import { DrizzleQueryError } from 'drizzle-orm'
import pg from 'pg'

type BulkReferenceStage = 'fixture' | 'prepare' | 'hold' | 'authorize' | 'replace' | 'read-back' | 'http-save' | 'http-read-back'
type StageRunner = <T>(stage: BulkReferenceStage, work: () => Promise<T>) => Promise<T>

function isDatabaseError(error: unknown): error is DrizzleQueryError | pg.DatabaseError {
  return error instanceof DrizzleQueryError || error instanceof pg.DatabaseError
}

/** 保底路径不调用未知 getter，不读消息、参数或 detail。 */
function dataField(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value as unknown
}

function fallbackSqlState(error: Error): string | undefined {
  let current: unknown = error
  try {
    for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
      const code = dataField(current, 'code')
      if (typeof code === 'string' && /^[\dA-Z]{5}$/u.test(code))
        return code
      current = dataField(current, 'cause')
    }
  }
  catch {
    // 不能因诊断对象无法检查而替换本来的数据库失败。
  }
  return undefined
}

/** 参数可能含换行和伪 ` at `，必须先精确剥掉整个已知数据库错误的消息。 */
function databaseFrames(error: unknown): string[] | undefined {
  if (!isDatabaseError(error))
    return undefined
  const message = dataField(error, 'message')
  const name = dataField(error, 'name') ?? 'Error'
  const stack = error.stack
  if (typeof message !== 'string' || typeof name !== 'string' || typeof stack !== 'string')
    return undefined
  const prefix = `${name}: ${message}\n`
  if (!stack.startsWith(prefix))
    return undefined
  return framesOnly(stack.slice(prefix.length))?.split('\n').slice(0, 4).map(frame => frame.length <= 180 ? frame : `${frame.slice(0, 79)}…${frame.slice(-100)}`)
}

/**
 * 仅用于该用例的固定占位符 SQL；不是任意内联 SQL 的全局脱敏器。
 * serializeError 对未知异常保留消息/自有字段，这里只摘数据库字段，未知 cause 不信任任意 stack。
 */
function diagnostic(serialized: unknown, original: unknown, depth = 0): Record<string, unknown> {
  if (typeof serialized !== 'object' || serialized === null)
    return { type: 'UnrecognizedDatabaseCause' }
  const fields = serialized as Record<string, unknown>
  const result: Record<string, unknown> = { type: 'UnrecognizedDatabaseCause' }
  if (original instanceof DrizzleQueryError && fields.type === 'DrizzleQueryError') {
    result.type = fields.type
    if (typeof fields.query === 'string')
      result.query = fields.query.slice(0, 1_024)
    if (typeof fields.paramCount === 'number' && Number.isSafeInteger(fields.paramCount))
      result.paramCount = fields.paramCount
  }
  else if (original instanceof pg.DatabaseError && fields.type === 'DatabaseError') {
    result.type = fields.type
    for (const key of ['sqlState', 'severity', 'schema', 'table', 'column', 'dataType', 'constraint', 'routine']) {
      if (typeof fields[key] === 'string')
        result[key] = fields[key].slice(0, 96)
    }
  }
  result.frames = databaseFrames(original)
  if (fields.cause !== undefined && depth < 5)
    result.cause = diagnostic(fields.cause, typeof original === 'object' && original !== null ? dataField(original, 'cause') : undefined, depth + 1)
  return result
}

function safeDiagnostic(error: Error): Record<string, unknown> {
  try {
    return diagnostic(serializeError(error), error)
  }
  catch {
    return { type: 'DatabaseDiagnostic', status: 'diagnostic-incomplete', sqlState: fallbackSqlState(error) }
  }
}

/** 阶段内只计时并传播原对象；TransactionRunner 的回滚/异常选择先正常完成。 */
export async function bulkReferenceTransaction<T>(assetCount: number, work: (stage: StageRunner) => Promise<T>): Promise<T> {
  const started = performance.now()
  let failed: { stage: BulkReferenceStage, elapsedMs: number, error: unknown } | undefined
  const stage: StageRunner = async (name, operation) => {
    const stageStarted = performance.now()
    try {
      const result = await operation()
      process.stdout.write(`${JSON.stringify({ event: 'bulk-reference-stage', stage: name, assetCount, elapsedMs: Math.round(performance.now() - stageStarted), status: 'passed' })}\n`)
      return result
    }
    catch (error) {
      failed = { stage: name, elapsedMs: Math.round(performance.now() - stageStarted), error }
      throw error
    }
  }
  try {
    return await work(stage)
  }
  catch (error) {
    if (!isDatabaseError(error))
      throw error
    const context = failed?.error === error ? { stage: failed.stage, elapsedMs: failed.elapsedMs } : { stage: 'transaction', elapsedMs: Math.round(performance.now() - started) }
    // 不将原对象放入 cause 或自有属性，避免 Vitest 再次展开 params/detail。
    const failure = new Error(JSON.stringify({ event: 'bulk-reference-stage', ...context, assetCount, status: 'failed', error: safeDiagnostic(error) }))
    failure.name = 'BulkReferenceDatabaseError'
    throw failure
  }
}

export async function bulkReferenceStage<T>(stage: BulkReferenceStage, assetCount: number, work: () => Promise<T>): Promise<T> {
  return bulkReferenceTransaction(assetCount, async run => run(stage, work))
}
