import type { ObserveResult, OpenedRecord } from '../../../shared/outbox/draft-writer.ts'
import type { RecoveryReader } from './recovery-reader.ts'
import { describe, expect, it, vi } from 'vitest'
import { NOW, sampleMeta } from '../../../shared/outbox/draft-record.test-support.ts'
import { deferred } from '../../../shared/outbox/outbox-lock.test-support.ts'
import { LOCAL_DRAFT_RETENTION_MS } from '../../../shared/outbox/writer-fence.ts'
import { settle } from '../fake-lease-clock.test-support.ts'
import { matchesReloadDraft } from './reload-recovery.ts'

function fixture() {
  const meta = sampleMeta()
  const key = { userId: meta.userId, documentId: meta.documentId }
  const expected = { ...key, clientInstanceId: meta.writtenBy, writeEpoch: meta.writeEpoch, writerId: meta.writerId }
  // 不需要 SDK 快照或有效 gzip：这里只能做认证元数据预检，不得解压/重放正文。
  const draft: Extract<ObserveResult, { kind: 'observed' }> = { kind: 'observed', observation: { key, id: 'only-preflight' }, writer: undefined, record: { kind: 'draft', meta, gzip: new Uint8Array([1]) } }
  const observe = vi.fn<RecoveryReader['observe']>().mockResolvedValue(draft)
  const refreshKey = vi.fn<RecoveryReader['refreshKey']>().mockResolvedValue(draft)
  const reader: RecoveryReader = { observe, refreshKey, remove: vi.fn(), notices: vi.fn(), clearNotice: vi.fn(), dispose: vi.fn() }
  let alive = true
  const check = async () => matchesReloadDraft({ expected, reader, key, pageFormat: meta.format, now: () => NOW, still: () => alive })
  return { meta, key, expected, draft, reader, observe, refreshKey, check, end: () => {
    alive = false
  } }
}

describe('原身份普通申请前的短期原件预检', () => {
  it.each(['page', 'record'] as const)('合法大写 UUID 位于 %s 时，与规范身份仍是同一原件', async (where) => {
    const h = fixture()
    const upper = { userId: h.key.userId.toUpperCase(), documentId: h.key.documentId.toUpperCase() }
    if (where === 'record') {
      const meta = { ...h.meta, ...upper, writtenBy: h.meta.writtenBy.toUpperCase(), writerId: h.meta.writerId.toUpperCase() }
      h.observe.mockResolvedValue({ ...h.draft, observation: { key: upper, id: 'same-record' }, record: { kind: 'draft', meta, gzip: new Uint8Array([1]) } })
    }
    expect(await matchesReloadDraft({ expected: h.expected, reader: h.reader, key: where === 'page' ? upper : h.key, pageFormat: h.meta.format, now: () => NOW, still: () => true })).toBe(true)
  })

  it.each([true, false])('认证身份匹配；在途=%s 只授予普通申请候选，不重放、不删、不解压，finally 关闭 Reader', async (inFlight) => {
    const h = fixture()
    h.observe.mockResolvedValue({ ...h.draft, record: { kind: 'draft', meta: { ...h.meta, inFlight: inFlight ? h.meta.inFlight : null }, gzip: new Uint8Array([1]) } })
    expect(await h.check()).toBe(true)
    expect(h.reader.dispose).toHaveBeenCalledOnce()
    expect(h.refreshKey).not.toHaveBeenCalled()
    expect(h.reader.remove).not.toHaveBeenCalled()
    expect(h.reader.notices).not.toHaveBeenCalled()
    expect(h.reader.clearNotice).not.toHaveBeenCalled()
  })

  it.each(['userId', 'documentId', 'writtenBy', 'writerId', 'writeEpoch'] as const)('认证元数据的 %s 不符不能复用身份', async (field) => {
    const h = fixture()
    const meta = { ...h.meta, [field]: field === 'writeEpoch' ? 99 : 'another' }
    h.observe.mockResolvedValue({ ...h.draft, record: { kind: 'draft', meta, gzip: new Uint8Array() } })
    expect(await h.check()).toBe(false)
    expect(h.reader.dispose).toHaveBeenCalledOnce()
  })

  it('观察或候选属于别的文档，即使元数据碰巧匹配也拒绝', async () => {
    const h = fixture()
    h.observe.mockResolvedValue({ ...h.draft, observation: { key: { ...h.key, documentId: 'another' }, id: 'foreign' } })
    expect(await h.check()).toBe(false)
    h.observe.mockResolvedValue(h.draft)
    expect(await matchesReloadDraft({ expected: h.expected, reader: h.reader, key: { ...h.key, userId: 'another' }, pageFormat: h.meta.format, now: () => NOW, still: () => true })).toBe(false)
  })

  it.each([
    { kind: 'absent' },
    { kind: 'newer-format', recordVersion: 9 },
    { kind: 'malformed' },
  ] as const)('原件 $kind 不凭记号授予资格', async (record) => {
    const h = fixture()
    h.observe.mockResolvedValue({ ...h.draft, record })
    expect(await h.check()).toBe(false)
    expect(h.reader.dispose).toHaveBeenCalledOnce()
  })

  it.each(['no-key', 'revoked', 'corrupted'] as const)('未认证 %s 元数据即使一致也不算原件归属', async (kind) => {
    const h = fixture()
    const record: OpenedRecord = kind === 'no-key' ? { kind, meta: h.meta } : { kind: 'unreadable', meta: h.meta, reason: kind }
    h.observe.mockResolvedValue({ ...h.draft, record })
    expect(await h.check()).toBe(false)
    expect(h.refreshKey).not.toHaveBeenCalled()
  })

  it.each(['expired', 'profile', 'format', 'sdk', 'invalid-sdk'] as const)('明确不合格 %s 原件不申请、不清理', async (reason) => {
    const h = fixture()
    const meta = { ...h.meta, updatedAt: reason === 'expired' ? NOW - LOCAL_DRAFT_RETENTION_MS - 1 : NOW, format: { ...h.meta.format } }
    if (reason === 'profile')
      meta.format.profile = 'new-profile'
    if (reason === 'format')
      meta.format.formatVersion += 1
    if (reason === 'sdk' || reason === 'invalid-sdk')
      meta.format.univerVersion = reason === 'sdk' ? '99.0.0' : 'broken'
    h.observe.mockResolvedValue({ ...h.draft, record: { kind: 'draft', meta, gzip: new Uint8Array() } })
    expect(await h.check()).toBe(false)
    expect(h.reader.remove).not.toHaveBeenCalled()
  })

  it.each([true, false])('旧钥刷新恰好一次，刷新后认证成功=%s', async (readable) => {
    const h = fixture()
    const stale: ObserveResult = { ...h.draft, record: { kind: 'unreadable', meta: h.meta, reason: 'stale-key' } }
    h.observe.mockResolvedValue(stale)
    if (!readable)
      h.refreshKey.mockResolvedValue(stale)
    expect(await h.check()).toBe(readable)
    expect(h.refreshKey).toHaveBeenCalledExactlyOnceWith(h.meta.keyVersion)
    expect(h.reader.dispose).toHaveBeenCalledOnce()
  })

  it.each(['observe', 'refresh', 'cancel-observe', 'cancel-refresh', 'before'] as const)('%s 失败/取消时释放 Reader，迟到结果没有资格', async (when) => {
    const h = fixture()
    const pending = deferred<ObserveResult>()
    // 红灯实现可能尚未开始读取；拒绝也必须由夹具接住，不能污染全局结果。
    void pending.promise.catch(() => {})
    if (when === 'before')
      h.end()
    if (when === 'refresh' || when === 'cancel-refresh') {
      h.observe.mockResolvedValue({ ...h.draft, record: { kind: 'unreadable', meta: h.meta, reason: 'stale-key' } })
      h.refreshKey.mockImplementation(async () => pending.promise)
    }
    else {
      h.observe.mockImplementation(async () => pending.promise)
    }
    const result = h.check()
    await settle()
    if (when.startsWith('cancel') || when === 'before') {
      h.end()
      pending.resolve(h.draft)
    }
    else {
      pending.reject(new Error('reader failed'))
    }
    expect(await result).toBe(false)
    expect(h.reader.dispose).toHaveBeenCalledOnce()
    if (when === 'before')
      expect(h.observe).not.toHaveBeenCalled()
  })
})
