import type { DraftSessionPermit } from '../outbox/session-fence.ts'
import { openSessionChannel } from '../lib/session-channel.ts'
import { createDraftMaintenanceStore } from '../outbox/draft-maintenance-store.ts'
import { createDraftStore } from '../outbox/draft-store.ts'
import { createLocalCleanup } from '../outbox/local-cleanup.ts'
import { opfsMirrorDirectory } from '../outbox/mirror-directory.ts'
import { withOutboxLock } from '../outbox/outbox-lock.ts'
import { canUseDraftSession, cleanupPermitOf } from '../outbox/session-fence.ts'
import { createSessionStore } from '../outbox/session-store.ts'
import { createDraftMaintenance } from './draft-maintenance.ts'
import { maintenanceIncludes } from './maintenance-page.ts'
import { watchMaintenanceSignals } from './maintenance-signals.ts'
import { publishLocalSession } from './session-events.ts'

function createBrowserMaintenance() {
  const storeOptions = { blockedTimeoutMs: 3_000 }
  const sessions = createSessionStore(storeOptions)
  const cleanup = createLocalCleanup({ sessions, store: { ...createDraftStore(storeOptions), ...createDraftMaintenanceStore(storeOptions) }, directory: opfsMirrorDirectory(), now: Date.now })
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
export function mountBrowserMaintenance() {
  const owner = shared ??= { runtime: createBrowserMaintenance(), users: 0 }
  owner.users += 1
  let disposed = false
  return {
    model: owner.runtime.model,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      owner.users -= 1
      if (owner.users === 0) {
        owner.runtime.dispose()
        if (shared === owner)
          shared = undefined
      }
    },
  }
}
