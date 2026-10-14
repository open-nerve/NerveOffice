import type { LeaseClock } from '../outbox/clock.ts'
import type { DraftSessionPermit } from '../outbox/session-fence.ts'
import type { DraftCatalog } from './draft-catalog.ts'
import { PAGE_CLIENT_FORMAT } from '../api/client-format.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'
import { replayContent, saveConflictCopy } from './content-api.ts'
import { createDocumentRecovery } from './document-recovery.ts'
import { createDraftCatalog } from './draft-catalog.ts'
import { readDraftFacts } from './draft-facts-api.ts'
import { createDraftInventory } from './draft-inventory.ts'

interface BrowserDraftCatalogOptions {
  readonly permit: DraftSessionPermit | undefined
  readonly still: () => boolean
  readonly onSessionProblem: (error: unknown) => void
  readonly reportError: (error: unknown) => void
}

/** 这里只组装浏览器能力；资格、恢复判定和页面渲染各自独立。 */
export function createBrowserDraftCatalog(options: BrowserDraftCatalogOptions): DraftCatalog {
  const permit = readDraftSessionPermit(options.permit)
  const pageId = crypto.randomUUID()
  let qualified = permit !== undefined
  const still = () => qualified && options.still()
  const inventory = createDraftInventory({ permit, still })
  const clock: LeaseClock = {
    now: () => performance.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, Math.min(delayMs, 2 ** 31 - 1))
      return () => clearTimeout(timer)
    },
  }
  async function confirm(): Promise<void> {
    const result = await inventory.check()
    if (result === 'session')
      qualified = false
    if (result !== 'active' || !still())
      throw new Error('本机草稿的登录资格尚未确认')
  }
  return createDraftCatalog({
    still,
    inventory,
    onSessionProblem: options.onSessionProblem,
    readFacts: async (ids) => {
      await confirm()
      const result = await readDraftFacts(ids)
      await confirm()
      return result
    },
    makeRecovery: ({ documentId, facts, title }) => createDocumentRecovery({
      key: { userId: permit?.userId ?? '', documentId },
      permit: () => permit,
      pageFormat: PAGE_CLIENT_FORMAT,
      writtenBy: pageId,
      clock,
      now: Date.now,
      still,
      facts,
      title,
      newId: () => crypto.randomUUID(),
      replay: async (request, gzip) => replayContent(documentId, request.request, gzip, request.writeEpoch),
      conflictCopy: saveConflictCopy,
      // 草稿页没有加载云端正文；旧回执的事实留在 RecoveryView，不重复下载快照。
      refreshCloud: async () => {},
      onSessionProblem: options.onSessionProblem,
      reportError: options.reportError,
    }),
  })
}
