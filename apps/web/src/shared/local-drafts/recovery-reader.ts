import type { LeaseClock } from '../outbox/clock.ts'
// 阅读时的独立恢复资格；不登记写入者。条件清理永远只使用产生原观察的那一个活宿主。
import type { LocalKeyHandle } from '../outbox/draft-codec.ts'
import type { DraftObservation } from '../outbox/draft-observation.ts'
import type { DraftKey } from '../outbox/draft-record.ts'
import type { ClearNoticeResult, NoticesResult, ObservedRemoveResult, ObserveResult, WriterProblem } from '../outbox/draft-writer.ts'
import type { LocalKeyKeeper } from '../outbox/local-key.ts'
import type { OutboxHost } from '../outbox/outbox-host.ts'
import type { DraftSessionPermit } from '../outbox/session-fence.ts'
import { describeFailure } from '../outbox/failure.ts'
import { createLocalKeyKeeper, fetchLocalKey } from '../outbox/local-key.ts'
import { createOutboxHost } from '../outbox/outbox-host.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'

export interface RecoveryReader {
  readonly observe: () => Promise<ObserveResult>
  readonly refreshKey: (version: number) => Promise<ObserveResult>
  readonly remove: (observation: DraftObservation) => Promise<ObservedRemoveResult>
  readonly notices: () => Promise<NoticesResult>
  readonly clearNotice: (at: number) => Promise<ClearNoticeResult>
  readonly dispose: () => void
}

export interface RecoveryReaderOptions {
  readonly permit: DraftSessionPermit | undefined
  readonly key: DraftKey
  readonly clock: LeaseClock
  readonly still: () => boolean
  readonly keeper?: LocalKeyKeeper
  readonly host?: (signal: AbortSignal) => Promise<OutboxHost>
  readonly onSessionProblem: (error: unknown) => void
}

interface ReaderHost {
  readonly host: OutboxHost
  installedKey: LocalKeyHandle | undefined
}

const INACTIVE: WriterProblem = { kind: 'failed', error: { name: 'RecoveryReaderInactive', message: '原恢复观察已失效，需要重新检查' } }
const failed = (error: unknown): WriterProblem => ({ kind: 'failed', error: describeFailure(error) })

export function createRecoveryReader(options: RecoveryReaderOptions): RecoveryReader {
  const permit = readDraftSessionPermit(options.permit)
  const key = Object.freeze({ ...options.key })
  const keeper = options.keeper ?? createLocalKeyKeeper({ fetch: fetchLocalKey, clock: options.clock, retry: { initialMs: 2_000, maxMs: 30_000 }, requestTimeoutMs: 10_000 })
  let disposed = false
  let active: ReaderHost | undefined
  let pending: { readonly controller: AbortController, readonly promise: Promise<ReaderHost | WriterProblem | undefined> } | undefined
  let serial = 0
  let observation: DraftObservation | undefined
  let observedKey: LocalKeyHandle | undefined
  let tail: Promise<unknown> = Promise.resolve()
  const closed = new WeakSet<OutboxHost>()

  function close(host: OutboxHost): void {
    if (closed.has(host))
      return
    closed.add(host)
    host.dispose()
  }

  function invalidate(): void {
    serial += 1
    observation = undefined
    observedKey = undefined
  }

  function closeHost(): void {
    invalidate()
    pending?.controller.abort()
    pending = undefined
    if (active !== undefined)
      close(active.host)
    active = undefined
  }

  const unsubscribe = keeper.subscribe(() => {
    // 初次无钥读取之后取到钥匙时，还没有交出观察，可在原宿主安装。已读出的资格或旧钥则立即作废。
    if (active?.installedKey !== undefined || observation !== undefined)
      closeHost()
  })

  function dispose(): void {
    if (disposed)
      return
    disposed = true
    unsubscribe()
    closeHost()
    keeper.discard()
  }

  function live(): boolean {
    if (!options.still())
      dispose()
    return !disposed
  }

  function valid(target: ReaderHost): boolean {
    if (!live() || active !== target)
      return false
    if (target.host.broken()) {
      closeHost()
      return false
    }
    return true
  }

  async function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work)
    tail = next.then(() => {}, () => {})
    return next
  }

  async function host(): Promise<ReaderHost | WriterProblem | undefined> {
    if (!live())
      return undefined
    if (permit === undefined || permit.userId !== key.userId)
      return { kind: 'session-invalid' }
    if (active !== undefined && valid(active))
      return active
    if (pending !== undefined)
      return pending.promise
    const controller = new AbortController()
    const promise = (async () => {
      const created = await (options.host ?? (async signal => createOutboxHost({ signal })))(controller.signal)
      try {
        if (!live() || controller.signal.aborted)
          return undefined
        const bound = await created.writer.bindSession(permit)
        if (!live() || controller.signal.aborted)
          return undefined
        if (bound.kind !== 'bound')
          return bound
        active = { host: created, installedKey: undefined }
        return active
      }
      finally {
        if (active?.host !== created)
          close(created)
      }
    })()
    const run = { controller, promise }
    pending = run
    try {
      return await promise
    }
    finally {
      if (pending === run)
        pending = undefined
    }
  }

  async function read(run: number, fetchKey: boolean, facts: { recordKnown: boolean }): Promise<ObserveResult> {
    if (!live() || run !== serial)
      return INACTIVE
    const target = await host()
    if (target !== undefined && 'kind' in target)
      return target
    if (target === undefined || !valid(target) || run !== serial)
      return INACTIVE
    const currentKey = keeper.current()
    if (target.installedKey !== currentKey) {
      const installed = await target.host.writer.setKey(currentKey)
      if (!valid(target) || run !== serial || keeper.current() !== currentKey)
        return INACTIVE
      if (installed.kind === 'failed')
        return installed
      target.installedKey = currentKey
    }
    const result = await target.host.writer.observe(key)
    if (!valid(target) || run !== serial || keeper.current() !== currentKey)
      return INACTIVE
    if (result.kind === 'observed')
      facts.recordKnown = result.record.kind !== 'absent'
    else if (result.recordKnown === true)
      facts.recordKnown = true
    if (result.kind !== 'observed')
      return result
    if (result.record.kind === 'no-key' && fetchKey) {
      const fetched = await keeper.ensure()
      if (!live() || run !== serial)
        return INACTIVE
      if (!('kind' in fetched))
        return read(run, false, facts)
      if (fetched.kind === 'session')
        options.onSessionProblem(fetched.error)
    }
    observation = Object.freeze({ key, id: result.observation.id })
    observedKey = currentKey
    return { ...result, observation }
  }

  async function observe(refresh?: number): Promise<ObserveResult> {
    invalidate()
    if (refresh !== undefined)
      keeper.observeVersion(refresh, false)
    const run = serial
    return enqueue(async () => {
      const facts = { recordKnown: false }
      const preserve = (result: ObserveResult): ObserveResult => result.kind !== 'observed' && facts.recordKnown ? { ...result, recordKnown: true } : result
      try {
        if (refresh !== undefined) {
          if (!live() || run !== serial)
            return INACTIVE
          const fetched = await keeper.ensure()
          if ('kind' in fetched && fetched.kind === 'session' && live())
            options.onSessionProblem(fetched.error)
        }
        return preserve(await read(run, refresh === undefined, facts))
      }
      catch (error) {
        return preserve(live() ? failed(error) : INACTIVE)
      }
    })
  }

  return {
    observe,
    refreshKey: observe,
    remove: async (original) => {
      const run = serial
      return enqueue(async () => {
        const target = active
        if (target === undefined || !valid(target) || run !== serial || observation !== original || keeper.current() !== observedKey)
          return INACTIVE
        try {
          const result = await target.host.writer.removeObserved(original)
          // 删除已提交的事实不能因随后失效改写成失败，但失效/新观察也不能重新取得旧资格。
          if (result.kind === 'removed' || result.kind === 'absent' || result.kind === 'changed') {
            if (run === serial)
              invalidate()
            return result
          }
          return valid(target) && run === serial ? result : INACTIVE
        }
        catch (error) {
          return valid(target) && run === serial ? failed(error) : INACTIVE
        }
      })
    },
    notices: async () => enqueue(async () => {
      try {
        const target = await host()
        if (target !== undefined && 'kind' in target)
          return target
        if (target === undefined || !valid(target))
          return INACTIVE
        const result = await target.host.writer.notices(key.userId)
        if (!valid(target))
          return INACTIVE
        return result.kind === 'notices' ? { ...result, notices: result.notices.filter(notice => notice.documentId === key.documentId) } : result
      }
      catch (error) {
        return live() ? failed(error) : INACTIVE
      }
    }),
    clearNotice: async at => enqueue(async () => {
      try {
        const target = await host()
        if (target !== undefined && 'kind' in target)
          return target
        if (target === undefined || !valid(target))
          return INACTIVE
        const result = await target.host.writer.clearNotice(key, at)
        return valid(target) ? result : INACTIVE
      }
      catch (error) {
        return live() ? failed(error) : INACTIVE
      }
    }),
    dispose,
  }
}
