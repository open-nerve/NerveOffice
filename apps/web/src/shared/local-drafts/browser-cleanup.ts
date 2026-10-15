import type { DraftStoreOptions } from '../outbox/draft-store.ts'
import type { LocalCleanup, LocalCleanupOptions } from '../outbox/local-cleanup.ts'
import { createDraftMaintenanceStore } from '../outbox/draft-maintenance-store.ts'
import { createDraftStore } from '../outbox/draft-store.ts'
import { createLocalCleanup } from '../outbox/local-cleanup.ts'
import { opfsMirrorDirectory } from '../outbox/mirror-directory.ts'
import { clearLegacyStorage } from './legacy-storage.ts'

/** 退出、确证停用和启动重试的同一份完整清单；平台不引用 SDK。 */
export function createBrowserCleanup(sessions: LocalCleanupOptions['sessions'], storeOptions: DraftStoreOptions): LocalCleanup {
  return createLocalCleanup({
    sessions,
    store: { ...createDraftStore(storeOptions), ...createDraftMaintenanceStore(storeOptions) },
    directory: opfsMirrorDirectory(),
    now: Date.now,
    clearMetadata: async userId => clearLegacyStorage(userId, {
      localStorage: () => window.localStorage,
      sessionStorage: () => window.sessionStorage,
      indexedDB: () => window.indexedDB,
    }),
  })
}
