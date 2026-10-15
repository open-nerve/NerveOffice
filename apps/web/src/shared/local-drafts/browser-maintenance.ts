import type { DraftSessionPermit } from '../outbox/session-fence.ts'
import { associatedSessionPermit } from '../api/session-association.ts'
import { currentApiSession } from '../api/session-context.ts'
import { openSessionChannel } from '../lib/session-channel.ts'
import { withOutboxLock } from '../outbox/outbox-lock.ts'
import { canUseDraftSession, cleanupPermitOf, readDraftSessionPermit } from '../outbox/session-fence.ts'
import { createSessionStore } from '../outbox/session-store.ts'
import { createBrowserCleanup } from './browser-cleanup.ts'
import { createDraftMaintenance } from './draft-maintenance.ts'
import { clearLegacySessionMarkers } from './legacy-storage.ts'
import { maintenanceIncludes } from './maintenance-page.ts'
import { watchMaintenanceSignals } from './maintenance-signals.ts'
import { publishLocalSession, subscribeLocalSession } from './session-events.ts'

function createBrowserMaintenance() {
  try {
    clearLegacySessionMarkers(window.sessionStorage)
  }
  catch { /* 普通启动不因退役记号清理失败阻断阅读；明确退出仍报告存储失败。 */ }
  const storeOptions = { blockedTimeoutMs: 3_000 }
  const sessions = createSessionStore(storeOptions)
  const cleanup = createBrowserCleanup(sessions, storeOptions)
  const readState = async () => withOutboxLock(async () => sessions.readState())
  async function check(permit: DraftSessionPermit): Promise<'active' | 'session' | 'storage'> {
    try {
      const read = await readState()
      if (read.kind !== 'state')
        return 'storage'
      if (canUseDraftSession(read.state, permit, permit.userId))
        return 'active'
      // 漏过广播的冻结页也必须放掉旧宿主；这一事实通知不提供任何新写入/清理资格。
      publishLocalSession({ kind: 'stopped', previous: permit, cleanup: undefined })
      return 'session'
    }
    catch {
      return 'storage'
    }
  }
  const model = createDraftMaintenance({
    cleanup,
    now: Date.now,
    readCleanup: async () => {
      const read = await readState()
      return read.kind === 'state' ? { kind: 'ready', permit: read.state === undefined ? undefined : cleanupPermitOf(read.state) } : { kind: 'unavailable' }
    },
    check,
    makeCatalog: async (permit, still) => {
      // 公开入口只做无身份维护；取得当前许可后才下载权限/恢复目录，保持平台首屏原分块。
      const { createBrowserDraftCatalog } = await import('./browser-draft-catalog.ts')
      const pathname = window.location.pathname
      return createBrowserDraftCatalog({
        permit,
        still: () => still() && window.location.pathname === pathname,
        include: documentId => maintenanceIncludes(pathname, documentId),
        onSessionProblem: () => {},
        reportError,
      })
    },
  })
  const channel = openSessionChannel()
  const stop = watchMaintenanceSignals({ model, channel, target: window, visibility: document, visible: () => document.visibilityState !== 'hidden' })
  return {
    model,
    dispose: () => {
      stop()
      model.dispose()
      channel.close()
    },
  }
}

let shared: { readonly runtime: ReturnType<typeof createBrowserMaintenance>, users: number } | undefined

/** 入口与按需状态组件共用一份运行时；最后一个使用者离开才释放。 */
export function mountBrowserMaintenance(onSessionDisabled?: () => void) {
  const owner = shared ??= { runtime: createBrowserMaintenance(), users: 0 }
  owner.users += 1
  let disposed = false
  const unsubscribe = onSessionDisabled === undefined
    ? undefined
    : subscribeLocalSession((event) => {
        if (event.kind !== 'stopped' || event.cleanup?.cause !== 'account_disabled')
          return
        const current = currentApiSession()
        const permit = current === undefined ? undefined : readDraftSessionPermit(associatedSessionPermit(current))
        // 后台请求不经过 QueryCache；只有本页仍采纳原代次时，才把已确证的原因交给页面复核。
        // 这只是说明通知，不向界面授予清理资格，也不把身份放进跨页广播。
        if (permit?.userId === event.previous.userId && permit.generation === event.previous.generation)
          onSessionDisabled()
      })
  return {
    model: owner.runtime.model,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      unsubscribe?.()
      owner.users -= 1
      if (owner.users === 0) {
        owner.runtime.dispose()
        if (shared === owner)
          shared = undefined
      }
    },
  }
}
