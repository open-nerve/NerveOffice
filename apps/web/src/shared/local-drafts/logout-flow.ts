import type { SessionResponse } from '@nerve-office/contracts'
import type { LocalCleanup, UserCleanupOutcome } from '../outbox/local-cleanup.ts'
import type { DraftSessionPermit, UserCleanupPermit } from '../outbox/session-fence.ts'
import type { DraftInventory, DraftInventoryEntry } from './draft-inventory.ts'
import { ApiError } from '../api/api-errors.ts'
import { readDraftSessionPermit, readUserCleanupPermit } from '../outbox/session-fence.ts'

export type LogoutQualification = 'active' | 'clearing' | 'cleared' | 'invalidated' | 'unavailable'
export interface LogoutDraftEntry extends DraftInventoryEntry { readonly title?: string | undefined }
export type LogoutPreview = { readonly kind: 'listed', readonly entries: readonly LogoutDraftEntry[], readonly incomplete: boolean } | Exclude<DraftInventory, { readonly kind: 'listed' }>
export type LogoutLocal = { readonly kind: 'idle' | 'unconfirmed' } | UserCleanupOutcome
export type LogoutServer = { readonly kind: 'idle' | 'ended' } | { readonly kind: 'unknown', readonly error: unknown }
export interface LogoutView {
  readonly stage: 'idle' | 'ready' | 'result' | 'invalidated'
  readonly busy: 'preview' | 'confirm' | 'retry' | undefined
  readonly preview: LogoutPreview | undefined
  readonly local: LogoutLocal
  readonly server: LogoutServer
  readonly canRetry: boolean
}
export interface LogoutFlowOptions {
  readonly session: SessionResponse
  readonly permit: DraftSessionPermit | undefined
  readonly inventory: { readonly load: () => Promise<LogoutPreview>, readonly dispose: () => void }
  readonly cleanup: Pick<LocalCleanup, 'beginUser' | 'removeUser'>
  /** 只比较原来源与原资格；cleared 是同一来源已完成清理的事实，不是新资格。 */
  readonly qualify: (cleanup: UserCleanupPermit | undefined) => Promise<LogoutQualification>
  readonly stopped: (previous: DraftSessionPermit, cleanup: UserCleanupPermit) => void
  readonly requestLogout: (session: SessionResponse) => Promise<void>
  readonly clearCache: () => void
  readonly still: () => boolean
}

const EMPTY: LogoutView = { stage: 'idle', busy: undefined, preview: undefined, local: { kind: 'idle' }, server: { kind: 'idle' }, canRetry: false }

/** 一次明确确认拥有一个原来源；本机清理与 HTTP 不在同一把锁内，结果也分别保留。 */
export function createLogoutFlow(options: LogoutFlowOptions) {
  const session = options.session
  const permit = readDraftSessionPermit(options.permit)
  let cleanup: UserCleanupPermit | undefined
  let state = EMPTY
  let disposed = false
  let confirmed = false
  let cacheCleared = false
  const listeners = new Set<() => void>()

  function publish(patch: Partial<LogoutView>): void {
    state = { ...state, ...patch }
    state = { ...state, canRetry: state.stage === 'result' && state.busy === undefined
      && (state.server.kind === 'unknown' || (permit !== undefined && state.local.kind !== 'cleared')) }
    for (const listener of [...listeners])
      listener()
  }

  function invalidate(): void {
    publish({ stage: 'invalidated', preview: undefined, local: { kind: 'invalidated' }, busy: undefined })
  }

  function live(): boolean {
    if (disposed || state.stage === 'invalidated')
      return false
    if (!options.still()) {
      invalidate()
      return false
    }
    return true
  }

  async function qualify(): Promise<LogoutQualification> {
    if (!live())
      return 'invalidated'
    let result: LogoutQualification
    try {
      result = await options.qualify(cleanup)
    }
    catch {
      result = 'unavailable'
    }
    if (!live())
      return 'invalidated'
    if (result === 'invalidated')
      invalidate()
    return result
  }

  async function preview(): Promise<void> {
    if (!live() || confirmed || state.busy !== undefined)
      return
    publish({ busy: 'preview', preview: undefined })
    let result: LogoutPreview
    try {
      result = await options.inventory.load()
    }
    catch {
      result = { kind: 'unavailable', reason: 'storage' }
    }
    const qualification = await qualify()
    if (qualification === 'invalidated')
      return
    if (qualification === 'unavailable') {
      result = { kind: 'unavailable', reason: 'storage' }
    }
    else if (result.kind === 'unavailable' && result.reason === 'session') {
      invalidate()
      return
    }
    publish({ stage: 'ready', preview: result, busy: undefined })
  }

  async function clean(qualification: LogoutQualification): Promise<void> {
    if (qualification === 'cleared' || state.local.kind === 'cleared') {
      publish({ local: { kind: 'cleared', pending: [] } })
      return
    }
    if (cleanup === undefined) {
      if (permit === undefined) {
        publish({ local: { kind: 'unconfirmed' } })
        return
      }
      let started: Awaited<ReturnType<LocalCleanup['beginUser']>>
      try {
        started = await options.cleanup.beginUser(permit, 'logout')
      }
      catch (error) {
        started = { kind: 'failed', error }
      }
      if (!live())
        return
      if (started.kind === 'session-invalid') {
        invalidate()
        return
      }
      if (started.kind !== 'clearing') {
        publish({ local: started })
        return
      }
      cleanup = readUserCleanupPermit(started.permit)
      if (cleanup === undefined || cleanup.userId !== permit.userId || cleanup.cause !== 'logout') {
        invalidate()
        return
      }
      try {
        options.stopped(permit, cleanup)
      }
      catch { /* 停写资格已提交；漏通知的 Worker 仍被持久栅栏挡住。 */ }
    }
    let result: UserCleanupOutcome
    try {
      result = await options.cleanup.removeUser(cleanup)
    }
    catch (error) {
      result = { kind: 'failed', error }
    }
    if (!live())
      return
    if (result.kind === 'invalidated')
      invalidate()
    else
      publish({ local: result })
  }

  async function endSession(): Promise<void> {
    if (state.server.kind === 'ended')
      return
    let result: LogoutServer
    try {
      await options.requestLogout(session)
      result = { kind: 'ended' }
    }
    catch (error) {
      if (error instanceof ApiError && error.status === 403 && error.code === 'CSRF_TOKEN_INVALID') {
        invalidate()
        return
      }
      const ended = error instanceof ApiError && error.status === 401 && (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED')
      result = ended ? { kind: 'ended' } : { kind: 'unknown', error }
    }
    if (!live())
      return
    publish({ server: result })
  }

  async function run(kind: 'confirm' | 'retry'): Promise<void> {
    publish({ stage: 'result', busy: kind, preview: undefined })
    try {
      const qualification = await qualify()
      if (qualification === 'invalidated')
        return
      await clean(qualification)
      if (await qualify() === 'invalidated')
        return
      await endSession()
      if (await qualify() === 'invalidated')
        return
      if (state.server.kind === 'ended' && !cacheCleared) {
        options.clearCache()
        cacheCleared = true
      }
    }
    finally {
      if (live())
        publish({ busy: undefined })
    }
  }

  return {
    view: (): LogoutView => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    preview,
    // 聚焦/恢复可见只核对原资格，不自动确认、重试或获取新会话。
    recheck: async (): Promise<void> => { await qualify() },
    confirm: async (): Promise<void> => {
      if (!live() || confirmed || state.stage !== 'ready' || state.busy !== undefined)
        return
      confirmed = true
      await run('confirm')
    },
    retry: async (): Promise<void> => {
      if (!live() || !confirmed || !state.canRetry || state.busy !== undefined)
        return
      await run('retry')
    },
    dispose: () => {
      if (disposed)
        return
      disposed = true
      options.inventory.dispose()
      invalidate()
      listeners.clear()
    },
  }
}

export type LogoutFlow = ReturnType<typeof createLogoutFlow>
