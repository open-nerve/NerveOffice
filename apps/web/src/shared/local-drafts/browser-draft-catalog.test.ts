import { expect, it, vi } from 'vitest'
import { DOCUMENT_ID, USER_ID } from '../outbox/draft-record.test-support.ts'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { testSessionPermit } from '../outbox/session-fence.test-support.ts'
import { installFakeApi, json } from '../testing/fake-api.test-support.ts'
import { createBrowserDraftCatalog } from './browser-draft-catalog.ts'

const inventory = vi.hoisted(() => ({
  check: vi.fn<() => Promise<'active' | 'session' | 'storage'>>(),
  load: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock('./draft-inventory.ts', () => ({ createDraftInventory: () => inventory }))

it('批量 HTTP 在途换了会话：持久资格复核拒绝整个旧页面，迟到标题也不显示', async () => {
  inventory.check.mockResolvedValueOnce('active').mockResolvedValue('session')
  inventory.load.mockResolvedValue({ kind: 'listed', entries: [{ documentId: DOCUMENT_ID, updatedAt: 1, mirrorOnly: false }], incomplete: false })
  const wait = deferred<Response>()
  const api = installFakeApi({ [`GET /api/documents/draft-facts?ids=${DOCUMENT_ID}`]: async () => wait.promise })
  const catalog = createBrowserDraftCatalog({ permit: testSessionPermit(USER_ID), still: () => true, onSessionProblem: vi.fn(), reportError: vi.fn() })
  try {
    const pending = catalog.refresh()
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    wait.resolve(json(200, { items: [{ status: 'accessible', id: DOCUMENT_ID, title: '另一个会话的标题', type: 'sheet', canEdit: true, revision: 1, revisionSource: null, occupied: false }] }))
    await pending
    expect(catalog.view()).toMatchObject({ problem: 'session', rows: [] })
    expect(api.requests).toHaveLength(1)
    expect(inventory.dispose).toHaveBeenCalled()
  }
  finally {
    catalog.dispose()
  }
})
