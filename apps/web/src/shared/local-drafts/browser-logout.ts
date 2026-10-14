import type { SessionResponse } from '@nerve-office/contracts'
import { setCsrfToken } from '../api/client.ts'
import { associatedSessionPermit } from '../api/session-association.ts'
import { openSessionChannel } from '../lib/session-channel.ts'
import { createDraftMaintenanceStore } from '../outbox/draft-maintenance-store.ts'
import { createDraftStore } from '../outbox/draft-store.ts'
import { createLocalCleanup } from '../outbox/local-cleanup.ts'
import { opfsMirrorDirectory } from '../outbox/mirror-directory.ts'
import { withOutboxLock } from '../outbox/outbox-lock.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'
import { createSessionStore } from '../outbox/session-store.ts'
import { readDraftFacts } from './draft-facts-api.ts'
import { createDraftInventory } from './draft-inventory.ts'
import { requestLogout } from './logout-api.ts'
import { createLogoutFlow } from './logout-flow.ts'
import { loadLogoutPreview } from './logout-preview.ts'
import { createLogoutQualification } from './logout-qualification.ts'
import { watchLogoutSource } from './logout-source.ts'
import { publishLocalSession } from './session-events.ts'

/** 浏览器端口与原响应在这里组装；HTTP、存储资格和视图各有单独的所有者。 */
export function createBrowserLogout(session: SessionResponse, clearCache: () => void) {
  const candidate = readDraftSessionPermit(associatedSessionPermit(session))
  const permit = candidate?.userId === session.user.id ? candidate : undefined
  const storeOptions = { blockedTimeoutMs: 3_000 }
  const sessions = createSessionStore(storeOptions)
  const cleanup = createLocalCleanup({ sessions, store: { ...createDraftStore(storeOptions), ...createDraftMaintenanceStore(storeOptions) }, directory: opfsMirrorDirectory(), now: Date.now })
  const channel = openSessionChannel()
  let alive = true
  let ended = false
  const inventory = createDraftInventory({ permit, still: () => alive })
  const flow = createLogoutFlow({
    session,
    permit,
    inventory: { load: async () => loadLogoutPreview({ inventory, readFacts: readDraftFacts }), dispose: inventory.dispose },
    cleanup: {
      beginUser: cleanup.beginUser,
      removeUser: async (original) => {
        const outcome = await cleanup.removeUser(original)
        publishLocalSession({ kind: 'cleanup', permit: original, outcome })
        return outcome
      },
    },
    qualify: createLogoutQualification({ session, permit, sessions, exclusive: withOutboxLock }),
    stopped: (previous, original) => {
      publishLocalSession({ kind: 'stopped', previous, cleanup: original })
      channel.announce()
    },
    requestLogout,
    clearCache: () => {
      ended = true
      setCsrfToken(undefined)
      clearCache()
      channel.announce()
    },
    still: () => alive,
  })
  const invalidate = (): void => {
    alive = false
    flow.dispose()
  }
  const stop = watchLogoutSource({ session, permit, ended: () => ended, invalidate, recheck: flow.recheck, channel, target: window, visibility: document, visible: () => document.visibilityState === 'visible' })
  return { flow, dispose: () => {
    stop()
    invalidate()
    channel.close()
  } }
}
