import { Buffer } from 'node:buffer'
import process from 'node:process'
import { APPLICATION_NAME } from '@nerve-office/api/testing'
import pg from 'pg'

export type BulkObservationStage = 'setup' | 'fixture' | 'fixture-assets' | 'fixture-quota' | 'fixture-links' | 'fixture-grant' | 'prepare' | 'hold' | 'authorize' | 'replace' | 'read-back' | 'read-back-assertions' | 'http-prepare' | 'login' | 'http-save' | 'http-read-back' | 'http-assertions'
type SqlName = 'begin' | 'commit' | 'rollback' | 'current-links-insert' | 'checkpoint-links-insert' | 'current-links-delete' | 'select' | 'insert' | 'update' | 'delete' | 'other'
type HttpName = 'login' | 'lease-acquire' | 'content-put' | 'lease-release'
type BodyMethod = 'json' | 'arrayBuffer' | 'text'
type ObservationName = BulkObservationStage | SqlName | HttpName | `${HttpName}-${BodyMethod}`
type Finish = (status: 'passed' | 'failed') => void
type Query = (this: object, ...args: unknown[]) => unknown

const MAX_RECORDS = 512
const MAX_BYTES = 96 * 1024
const TRUNCATED = `${JSON.stringify({ event: 'bulk-reference-observation', status: 'truncated' })}\n`

/** 观测不调用未知 getter；不能识别时原样放行，由真实调用方决定结果。 */
function field(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
  }
  catch {
    return undefined
  }
}

function sqlName(args: readonly unknown[]): SqlName | undefined {
  const first = args[0]
  const text = typeof first === 'string' ? first : field(first, 'text')
  // Query/stream 或 config.callback 不在本例使用的 Promise/末参数 callback 形式内。
  if (typeof text !== 'string' || field(first, 'callback') !== undefined || field(first, 'submit') !== undefined)
    return undefined
  const prefix = text.slice(0, 256).trimStart().toLowerCase()
  if (/^insert into (?:"?public"?\.)?"?document_asset_links"?\s/u.test(prefix))
    return 'current-links-insert'
  if (/^insert into (?:"?public"?\.)?"?document_checkpoint_assets"?\s/u.test(prefix))
    return 'checkpoint-links-insert'
  if (/^delete from (?:"?public"?\.)?"?document_asset_links"?\s/u.test(prefix))
    return 'current-links-delete'
  for (const name of ['begin', 'commit', 'rollback', 'select', 'insert', 'update', 'delete'] as const) {
    if (new RegExp(`^${name}(?:\\s|;|$)`, 'u').test(prefix))
      return name
  }
  return 'other'
}

function httpName(origin: string, input: unknown, init: unknown): HttpName | undefined {
  // 本例的 asUser/postLogin 均用字符串 URL；不读未知 Request/URL 对象的 getter。
  if (typeof input !== 'string' || input.length > 16_384)
    return undefined
  const method = field(init, 'method')
  if (typeof method !== 'string')
    return undefined
  try {
    const url = new URL(input)
    if (url.origin !== origin)
      return undefined
    if (method === 'POST' && url.pathname === '/api/auth/login')
      return 'login'
    if (/^\/api\/documents\/[\da-f-]{36}\/edit-lease$/u.test(url.pathname))
      return method === 'POST' ? 'lease-acquire' : method === 'DELETE' ? 'lease-release' : undefined
    return method === 'PUT' && /^\/api\/documents\/[\da-f-]{36}\/content$/u.test(url.pathname) ? 'content-put' : undefined
  }
  catch {
    return undefined
  }
}

export interface BulkObservationOptions {
  readonly databaseName: string
  readonly baseUrl: string
  readonly assetCount: number
}

export interface BulkReferenceObservation {
  readonly stage: <T>(name: BulkObservationStage, operation: () => T) => T
  readonly restore: () => void
}

/** 仅这一条测试安装；不持有 SQL/参数/响应正文，不延长任何原操作或时限。 */
export function observeBulkReferences(options: BulkObservationOptions): BulkReferenceObservation {
  const started = performance.now()
  const origin = new URL(options.baseUrl).origin
  let closed = false
  let stopped = false
  let records = 0
  let bytes = 0
  let sequence = 0
  const connections = new WeakMap<object, number>()
  let connectionCount = 0
  const bodyRestorers = new Set<() => void>()

  function emit(value: Record<string, unknown>): void {
    if (closed || stopped)
      return
    try {
      const line = `${JSON.stringify({ event: 'bulk-reference-observation', ...value })}\n`
      const size = Buffer.byteLength(line)
      // 给唯一的终止标记预留一条和字节；额度耗尽后也不再挂新 promise 观察者。
      if (records + 1 >= MAX_RECORDS || bytes + size + Buffer.byteLength(TRUNCATED) > MAX_BYTES) {
        stopped = true
        process.stdout.write(TRUNCATED)
        return
      }
      records += 1
      bytes += size
      process.stdout.write(line)
    }
    catch {
      stopped = true
    }
  }

  function begin(kind: 'stage' | 'sql' | 'http' | 'body', name: ObservationName, connection?: number): Finish | undefined {
    if (closed || stopped)
      return undefined
    const at = performance.now()
    const operation = ++sequence
    let finished = false
    const record = (status: 'started' | 'passed' | 'failed') => emit({ kind, name, operation, assetCount: options.assetCount, ...(connection === undefined ? {} : { connection }), status, elapsedMs: Math.round(performance.now() - at), totalMs: Math.round(performance.now() - started) })
    record('started')
    if (stopped)
      return undefined
    return (status) => {
      if (!finished) {
        finished = true
        record(status)
      }
    }
  }

  function watch<T>(result: Promise<T>, finish: Finish, resolved?: (value: T) => void): void {
    // 两个观察分支都正常返回；不创建一个无人接收的 rejected 派生 promise。
    void result.then((value) => {
      try {
        if (!closed && !stopped)
          resolved?.(value)
      }
      catch {
        // 无法安装正文观测时仍原样交回真实 Response。
      }
      finish('passed')
    }, () => finish('failed'))
  }

  function stage<T>(name: BulkObservationStage, operation: () => T): T {
    const finish = begin('stage', name)
    try {
      const result = operation()
      if (finish !== undefined) {
        if (result instanceof Promise)
          watch(result, finish)
        else
          finish('passed')
      }
      return result
    }
    catch (error) {
      finish?.('failed')
      throw error
    }
  }

  const prototype = pg.Client.prototype as unknown as { query: Query }
  const originalQuery = prototype.query
  const query: Query = function (...args) {
    const parameters = field(this, 'connectionParameters')
    const name = field(parameters, 'database') === options.databaseName && field(parameters, 'application_name') === APPLICATION_NAME ? sqlName(args) : undefined
    if (name === undefined || closed || stopped)
      return originalQuery.apply(this, args)
    let connection = connections.get(this)
    if (connection === undefined) {
      connection = ++connectionCount
      connections.set(this, connection)
    }
    const finish = begin('sql', name, connection)
    const callback = args.at(-1)
    const actual = typeof callback === 'function' && finish !== undefined
      ? [...args.slice(0, -1), function (this: unknown, ...values: unknown[]) {
          finish(values[0] === null || values[0] === undefined ? 'passed' : 'failed')
          return Reflect.apply(callback, this, values) as unknown
        }]
      : args
    try {
      const result = originalQuery.apply(this, actual)
      if (finish !== undefined && typeof callback !== 'function' && result instanceof Promise)
        watch(result, finish)
      return result
    }
    catch (error) {
      finish?.('failed')
      throw error
    }
  }
  prototype.query = query

  function observeBody(response: Response, name: HttpName): void {
    if (Object.getPrototypeOf(response) !== Response.prototype)
      return
    for (const method of ['json', 'arrayBuffer', 'text'] as const) {
      if (Object.getOwnPropertyDescriptor(response, method) !== undefined)
        continue
      const original = Response.prototype[method]
      // eslint-disable-next-line ts/promise-function-async -- 必须返回正文读取自己的 Promise，不能新增 async 转发层。
      const wrapped = function (this: Response): Promise<unknown> {
        const finish = begin('body', `${name}-${method}`)
        try {
          const result: Promise<unknown> = original.call(this)
          if (finish !== undefined)
            watch(result, finish)
          return result
        }
        catch (error) {
          finish?.('failed')
          throw error
        }
      }
      Object.defineProperty(response, method, { value: wrapped, configurable: true, writable: true })
      bodyRestorers.add(() => {
        if (field(response, method) === wrapped)
          Reflect.deleteProperty(response, method)
      })
    }
  }

  const originalFetch = globalThis.fetch
  // eslint-disable-next-line ts/promise-function-async -- 保留原 fetch Promise 及调用接收者，观测只订阅完成。
  const observedFetch: typeof fetch = function (this: unknown, ...args) {
    const name = httpName(origin, args[0], args[1])
    const finish = name === undefined ? undefined : begin('http', name)
    try {
      const result = originalFetch.apply(this, args)
      if (finish !== undefined && name !== undefined)
        watch(result, finish, response => observeBody(response, name))
      return result
    }
    catch (error) {
      finish?.('failed')
      throw error
    }
  }
  globalThis.fetch = observedFetch

  return {
    stage,
    restore: () => {
      closed = true
      for (const restore of [...bodyRestorers].reverse()) {
        try {
          restore()
        }
        catch {
          // 观测收尾不能覆盖原失败。
        }
      }
      bodyRestorers.clear()
      if (globalThis.fetch === observedFetch)
        globalThis.fetch = originalFetch
      if (prototype.query === query)
        prototype.query = originalQuery
    },
  }
}
