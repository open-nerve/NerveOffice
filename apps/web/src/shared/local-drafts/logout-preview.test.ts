import type { DocumentDraftFact } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { loadLogoutPreview } from './logout-preview.ts'

const ENTRY = { documentId: 'doc', updatedAt: 1000, mirrorOnly: false }
const FACT: DocumentDraftFact = { id: 'doc', status: 'accessible', title: '预算', type: 'sheet', canEdit: true, revision: 1, revisionSource: null, occupied: false }
function fixture() {
  const inventory = { load: vi.fn(async () => ({ kind: 'listed' as const, entries: [ENTRY], incomplete: false })), check: vi.fn<() => Promise<'active' | 'session' | 'storage'>>(async () => 'active') }
  const readFacts = vi.fn(async () => new Map<string, DocumentDraftFact>([['doc', FACT]]))
  return { inventory, readFacts }
}

describe('退出只读预览的权限边界', () => {
  it('实际核对权限后才交出标题，保留时间与镜像事实', async () => {
    const t = fixture()
    expect(await loadLogoutPreview(t)).toEqual({ kind: 'listed', entries: [{ ...ENTRY, title: '预算' }], incomplete: false })
    expect(t.inventory.check).toHaveBeenCalledTimes(2)
    expect(t.readFacts).toHaveBeenCalledExactlyOnceWith(['doc'])
  })
  it('不可读项只保留通用元数据，预览不会删除；未知权限不伪造完整列表', async () => {
    const t = fixture()
    t.readFacts.mockResolvedValueOnce(new Map([['doc', { id: 'doc', status: 'unavailable' }]]))
    expect(await loadLogoutPreview(t)).toEqual({ kind: 'listed', entries: [{ ...ENTRY, title: undefined }], incomplete: false })
    t.readFacts.mockRejectedValueOnce(new Error('offline'))
    expect(await loadLogoutPreview(t)).toEqual({ kind: 'listed', entries: [{ ...ENTRY, title: undefined }], incomplete: true })
  })
  it('取标题期间换人，迟到标题全部丢弃', async () => {
    const t = fixture()
    const pending = deferred<ReadonlyMap<string, DocumentDraftFact>>()
    t.readFacts.mockImplementationOnce(async () => new Map(await pending.promise))
    const result = loadLogoutPreview(t)
    await vi.waitFor(() => expect(t.readFacts).toHaveBeenCalled())
    t.inventory.check.mockResolvedValue('session')
    pending.resolve(new Map([['doc', FACT]]))
    expect(await result).toEqual({ kind: 'unavailable', reason: 'session' })
  })
  it('存储不能核对资格时不索取标题', async () => {
    const t = fixture()
    t.inventory.check.mockResolvedValue('storage')
    expect(await loadLogoutPreview(t)).toEqual({ kind: 'unavailable', reason: 'storage' })
    expect(t.readFacts).not.toHaveBeenCalled()
  })
})
