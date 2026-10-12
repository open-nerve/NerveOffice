import type { CreatedDocument } from '@nerve-office/contracts'
import type { ObserveResult } from '../../../shared/outbox/draft-writer.ts'
import type { RecoveryAccessFacts, RecoveryInstall } from './document-recovery.ts'
import type { RecoveryReader } from './recovery-reader.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../../shared/api/index.ts'
import { gunzipBytes, gzipBytes } from '../../../shared/outbox/draft-codec.ts'
import { DOCUMENT_ID, NOW, sampleMeta, USER_ID } from '../../../shared/outbox/draft-record.test-support.ts'
import { deferred } from '../../../shared/outbox/outbox-lock.test-support.ts'
import { fakeLeaseClock, settle } from '../fake-lease-clock.test-support.ts'
import { createDocumentRecovery } from './document-recovery.ts'

const KEY = { userId: USER_ID, documentId: DOCUMENT_ID }
const BODY = '{"body":"原本机未同步内容"}'
const FACTS: RecoveryAccessFacts = { access: 'editable', online: true, current: { revision: 7, source: null, occupied: false } }
const CREATED = { id: 'copied-document', title: '原文档（冲突副本）', revision: 1 } as CreatedDocument
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup()
})

async function fixture() {
  const bytes = new TextEncoder().encode(BODY)
  const meta = sampleMeta({ baseRevision: 7, draftSeq: 37, rawBytes: bytes.byteLength, inFlight: null })
  const original: Extract<ObserveResult, { kind: 'observed' }> = { kind: 'observed', observation: { key: KEY, id: 'original' }, record: { kind: 'draft', meta, gzip: await gzipBytes(bytes) }, writer: undefined }
  const observe = vi.fn(async (): Promise<ObserveResult> => original)
  const remove = vi.fn<RecoveryReader['remove']>().mockResolvedValue({ kind: 'removed', mirror: { kind: 'removed' } })
  const refreshKey = vi.fn<RecoveryReader['refreshKey']>().mockResolvedValue(original)
  const notices = vi.fn<RecoveryReader['notices']>().mockResolvedValue({ kind: 'notices', notices: [] })
  const clearNotice = vi.fn<RecoveryReader['clearNotice']>().mockResolvedValue({ kind: 'cleared' })
  const reader: RecoveryReader = { observe, remove, refreshKey, notices, clearNotice, dispose: vi.fn() }
  const makeReader = vi.fn(() => reader)
  const facts = vi.fn(async () => FACTS)
  const replay = vi.fn(async () => ({ revision: 8, savedAt: new Date(NOW).toISOString(), unchanged: false }))
  const refreshCloud = vi.fn(async () => {})
  const conflictCopy = vi.fn(async () => CREATED)
  const install = vi.fn<RecoveryInstall>().mockImplementation(async (snapshot, formulasPending) => ({ kind: 'installed', capture: { snapshot, formulasPending, editorSeq: 0 } }))
  let alive = true
  let ids = 0
  const onSessionProblem = vi.fn()
  const recovery = createDocumentRecovery({ key: KEY, pageFormat: meta.format, writtenBy: 'new-page', clock: fakeLeaseClock(NOW).clock, now: () => NOW, still: () => alive, facts, reader: makeReader, replay, refreshCloud, conflictCopy, title: () => '原文档', newId: () => `copy-${++ids}`, onSessionProblem, reportError: vi.fn() })
  cleanups.push(recovery.dispose)
  return {
    recovery,
    original,
    meta,
    observe,
    remove,
    refreshKey,
    notices,
    clearNotice,
    reader,
    makeReader,
    facts,
    replay,
    refreshCloud,
    conflictCopy,
    install,
    onSessionProblem,
    end: () => { alive = false },
    return: () => { alive = true },
  }
}

describe('文档恢复的发现与条件动作', () => {
  it.each(['writerId', 'writtenBy', 'writeEpoch'] as const)('点击后原件 %s 改变，在旧回执核对或自动清理之前停止', async (field) => {
    const h = await fixture()
    await h.recovery.discover()
    const prepare = h.recovery.beginRestore()
    const meta = { ...h.meta, [field]: field === 'writeEpoch' ? h.meta.writeEpoch + 1 : 'replacement', inFlight: { requestId: 'new-request', clientInstanceId: 'new-page', localSeq: 37, sentAt: NOW - 1000 } }
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta, gzip: new Uint8Array([1, 2, 3]) } })
    expect(await prepare({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'changed' })
    expect(h.replay).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.install).not.toHaveBeenCalled()
  })

  it('点击后同一写入者继续落盘，采用最新正文与序号；登记后的新 writer 不改变原件来源', async () => {
    const h = await fixture()
    await h.recovery.discover()
    const prepare = h.recovery.beginRestore()
    const snapshot = '{"body":"交接期间的最后一次落盘"}'
    const bytes = new TextEncoder().encode(snapshot)
    const meta = { ...h.meta, draftSeq: 38, rawBytes: bytes.byteLength, updatedAt: NOW + 1 }
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta, gzip: await gzipBytes(bytes) }, writer: { ...KEY, writeEpoch: 99, writerId: 'registered-new-writer', lastDraftSeq: 38, registeredAt: NOW + 2 } })
    expect(await prepare({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)).toMatchObject({ kind: 'restore', capture: { snapshot }, highWater: 38 })
    expect(h.install).toHaveBeenCalledExactlyOnceWith(snapshot, false)
  })

  it.each(['same', 'different'] as const)('点击后的旧钥刷新得到 %s 认证来源，才决定是否允许采用', async (source) => {
    const h = await fixture()
    await h.recovery.discover()
    const prepare = h.recovery.beginRestore()
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'unreadable', meta: h.meta, reason: 'stale-key' } })
    const meta = { ...h.meta, writerId: source === 'same' ? h.meta.writerId : 'new-writer' }
    h.refreshKey.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta, gzip: await gzipBytes(new TextEncoder().encode(BODY)) } })
    const result = await prepare({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)
    expect(result).toMatchObject(source === 'same' ? { kind: 'restore' } : { kind: 'blocked', reason: 'changed' })
    expect(h.refreshKey).toHaveBeenCalledOnce()
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.install).toHaveBeenCalledTimes(source === 'same' ? 1 : 0)
  })

  it('明确放弃当前原件成功后，普通编辑不再绑定已结束的旧来源', async () => {
    const h = await fixture()
    await h.recovery.discover()
    const discard = h.recovery.beginDiscard()
    expect(discard).toBeDefined()
    await h.recovery.discard(discard!)
    expect(h.recovery.view().stage).toBe('finished')
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta: { ...h.meta, writerId: 'new-writer' }, gzip: await gzipBytes(new TextEncoder().encode(BODY)) } })
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)).toMatchObject({ kind: 'restore' })
    expect(h.install).toHaveBeenCalledOnce()
  })

  it('旧原件清理迟到不能清掉已展示新原件的来源绑定', async () => {
    const h = await fixture()
    const prepared = await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)
    if (prepared.kind !== 'restore')
      throw new Error('需要初值')
    const removed = deferred<Awaited<ReturnType<RecoveryReader['remove']>>>()
    h.remove.mockReturnValueOnce(removed.promise)
    const confirmation = prepared.onConfirmed?.()
    await vi.waitFor(() => expect(h.remove).toHaveBeenCalledOnce())
    const gzip = await gzipBytes(new TextEncoder().encode(BODY))
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta: { ...h.meta, writerId: 'writer-b' }, gzip } })
    await h.recovery.discover()
    removed.resolve({ kind: 'removed', mirror: { kind: 'removed' } })
    await confirmation
    const prepare = h.recovery.beginRestore()
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta: { ...h.meta, writerId: 'writer-c' }, gzip } })
    expect(await prepare({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'changed' })
    expect(h.install).toHaveBeenCalledOnce()
  })

  it('暂停使旧点击失效，之后发现同一原件也不能复活旧安装器', async () => {
    const h = await fixture()
    await h.recovery.discover()
    const prepare = h.recovery.beginRestore()
    h.recovery.suspend()
    await h.recovery.discover()
    expect(await prepare({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'cancelled' })
    expect(h.install).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('部署关闭时明确恢复沿统一内存入口采用已认证原件', async () => {
    const h = await fixture()
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)).toMatchObject({ kind: 'restore', baseRevision: 7 })
    expect(h.install).toHaveBeenCalledExactlyOnceWith(BODY, false)
  })

  it.each(['denied', 'unsupported'] as const)('浏览器明确 %s 且从未发现旧记录时，只准固定内存编辑云端内容', async (reason) => {
    const h = await fixture()
    h.observe.mockResolvedValue({ kind: 'unavailable', reason })
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'unavailable', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'memory', reason: 'unavailable' })
    expect(h.recovery.view().decision).toEqual({ kind: 'preserve', reason: 'storage' })
    expect(h.install).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.reader.dispose).toHaveBeenCalledOnce()
  })

  it.each([
    { kind: 'failed', error: { name: 'MirrorUnverified', message: '镜像忙' } },
    { kind: 'quota' },
    { kind: 'unavailable', reason: 'blocked' },
    { kind: 'unavailable', reason: 'newer-version' },
  ] as const)('未知存储问题 %j 不能借内存退路跳过恢复', async (failure) => {
    const h = await fixture()
    h.observe.mockResolvedValue(failure)
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'unavailable', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(h.install).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('已经发现旧记录之后存储被禁止，多次失败也不能遗忘原件而退成空白内存编辑', async () => {
    const h = await fixture()
    await h.recovery.discover()
    h.observe.mockResolvedValue({ kind: 'unavailable', reason: 'denied' })
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'unavailable', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(h.install).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'absent' } })
    await h.recovery.discover()
    h.observe.mockResolvedValue({ kind: 'unavailable', reason: 'denied' })
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'unavailable', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'memory', reason: 'unavailable' })
  })

  it('existing 端口本身已证明有旧记录，后续观察均被禁止也不能退成固定内存编辑', async () => {
    const h = await fixture()
    h.observe.mockResolvedValue({ kind: 'unavailable', reason: 'denied' })
    expect(await h.recovery.beginRestore()({ kind: 'existing', highWater: 37, observe: h.observe, remove: h.remove, retire: vi.fn() }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'unavailable', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(h.install).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'unavailable', reason: 'denied', recordKnown: true },
    { kind: 'failed', error: { name: 'MirrorUnreadable', message: '第二槽读取失败' }, recordKnown: true },
  ] as const)('读取没有完成但已发现旧记录，多次存储拒绝也不能越过恢复：$kind', async (first) => {
    const h = await fixture()
    h.observe.mockResolvedValueOnce(first).mockResolvedValue({ kind: 'unavailable', reason: 'denied' })
    await h.recovery.discover()
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'unavailable', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(h.install).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('登记失败已经发现原件，即使独立 Reader 从一开始就被禁止也不能进入内存编辑', async () => {
    const h = await fixture()
    h.observe.mockResolvedValue({ kind: 'unavailable', reason: 'denied' })
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'unavailable', highWater: 0, recordKnown: true }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(h.install).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('发现期间自动清理结束之后，先读通知再退休 Reader；提示不因提前关闭而丢失', async () => {
    const h = await fixture()
    let closed = false
    vi.mocked(h.reader.dispose).mockImplementation(() => {
      closed = true
    })
    h.notices.mockImplementation(async () => ({ kind: 'notices', notices: closed ? [] : [{ ...KEY, kind: 'lost', at: NOW }] }))
    h.facts.mockResolvedValue({ ...FACTS, access: 'unreadable' })
    await h.recovery.discover()
    expect(h.recovery.view().notice).toMatchObject({ kind: 'lost', at: NOW })
    expect(h.reader.dispose).toHaveBeenCalledOnce()
  })

  it.each([false, true])('没有草稿时发现结束即关闭 Reader，通知存在=%s 不占用空闲 Worker', async (hasNotice) => {
    const h = await fixture()
    h.observe.mockResolvedValue({ kind: 'observed', observation: h.original.observation, record: { kind: 'absent' }, writer: undefined })
    if (hasNotice)
      h.notices.mockResolvedValue({ kind: 'notices', notices: [{ ...KEY, kind: 'restored', at: NOW }] })
    await h.recovery.discover()
    expect(h.reader.dispose).toHaveBeenCalledOnce()
    expect(h.recovery.view().decision).toEqual({ kind: 'none' })
    if (hasNotice) {
      await h.recovery.acknowledge(NOW)
      expect(h.makeReader).toHaveBeenCalledTimes(2)
      expect(h.clearNotice).toHaveBeenCalledExactlyOnceWith(NOW)
    }
  })

  it('视图只交元数据，发现可恢复内容时不安装、不上传、不清理', async () => {
    const h = await fixture()
    await h.recovery.discover()
    expect(h.recovery.view()).toMatchObject({ stage: 'ready', decision: { kind: 'restore', baseRevision: 7 }, updatedAt: NOW })
    const view = JSON.stringify(h.recovery.view())
    expect(view).not.toContain('原本机未同步内容')
    expect(view).not.toContain('gzip')
    expect(view).not.toContain('original')
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.replay).not.toHaveBeenCalled()
    expect(h.conflictCopy).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'offline'] as const)('%s 保留原件，不核对或删除', async (reason) => {
    const h = await fixture()
    h.facts.mockResolvedValue({ ...FACTS, access: reason === 'unknown' ? 'unknown' : 'editable', online: reason !== 'offline' })
    await h.recovery.discover()
    expect(h.recovery.view()).toMatchObject({ decision: { kind: 'preserve', reason: reason === 'unknown' ? 'session' : 'offline' } })
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.replay).not.toHaveBeenCalled()
  })

  it('旧钥只刷新一次；持续不一致保留，不能按损坏清理', async () => {
    const h = await fixture()
    const stale: ObserveResult = { ...h.original, record: { kind: 'unreadable', meta: h.meta, reason: 'stale-key' } }
    h.observe.mockResolvedValue(stale)
    h.refreshKey.mockResolvedValue(stale)
    await h.recovery.discover()
    expect(h.refreshKey).toHaveBeenCalledExactlyOnceWith(h.meta.keyVersion)
    expect(h.recovery.view()).toMatchObject({ decision: { kind: 'preserve', reason: 'key' } })
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('可认证但 gzip 损坏时只条件清理原观察；清理失败保留原凭证重试', async () => {
    const h = await fixture()
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta: h.meta, gzip: new Uint8Array([1, 2, 3]) } })
    h.remove.mockResolvedValueOnce({ kind: 'quota' })
    await h.recovery.discover()
    expect(h.recovery.view()).toMatchObject({ decision: { kind: 'remove', reason: 'corrupted' }, cleanup: { kind: 'quota' } })
    expect(h.remove).toHaveBeenCalledWith(h.original.observation)
    const observed = h.observe.mock.calls.length
    await h.recovery.retryCleanup()
    expect(h.observe).toHaveBeenCalledTimes(observed)
    expect(h.remove).toHaveBeenCalledTimes(2)
    expect(h.recovery.view()).toMatchObject({ cleanup: { kind: 'removed' } })
  })

  it('旧保存确认后重新取当前云端，绝不把旧回执正文装入 SDK', async () => {
    const h = await fixture()
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta: { ...h.meta, inFlight: { requestId: 'old-request', clientInstanceId: 'old-page', localSeq: 37, sentAt: NOW - 1000 } }, gzip: h.original.record.kind === 'draft' ? h.original.record.gzip : new Uint8Array() } })
    await h.recovery.discover()
    expect(h.replay).toHaveBeenCalledOnce()
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(h.original.observation)
    expect(h.refreshCloud).toHaveBeenCalledOnce()
    expect(h.recovery.view()).toMatchObject({ decision: { kind: 'confirmed', revision: 8 } })
    expect(h.install).not.toHaveBeenCalled()
  })

  it('旧保存结果未知时不提供恢复安装或删除，原件保留', async () => {
    const h = await fixture()
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta: { ...h.meta, inFlight: { requestId: 'old-request', clientInstanceId: 'old-page', localSeq: 37, sentAt: NOW - 1000 } }, gzip: new Uint8Array([1]) } })
    h.replay.mockRejectedValue(new NetworkError('回包未知'))
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(h.install).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('恢复使用登记后的会话观察，自检成功的重算内容才交给采用', async () => {
    const h = await fixture()
    await h.recovery.discover()
    const fresh = { ...h.original, observation: { key: KEY, id: 'after-register' }, writer: { ...KEY, writeEpoch: 4, writerId: 'new-writer', lastDraftSeq: 91, registeredAt: NOW } }
    const observe = vi.fn(async () => fresh)
    const remove = vi.fn<RecoveryReader['remove']>().mockResolvedValue({ kind: 'absent' })
    h.install.mockResolvedValue({ kind: 'installed', capture: { snapshot: '重算后内容', editorSeq: 0, formulasPending: false } })
    const result = await h.recovery.beginRestore()({ kind: 'existing', highWater: 92, observe, remove, retire: vi.fn() }, FACTS, h.install)
    expect(result).toMatchObject({ kind: 'restore', capture: { snapshot: '重算后内容' }, highWater: 92, recoveryObservation: fresh.observation })
    expect(h.install).toHaveBeenCalledWith(BODY, false)
    expect(observe).toHaveBeenCalledOnce()
    expect(h.reader.dispose).toHaveBeenCalledOnce()
    if (result.kind !== 'restore')
      throw new Error('需要恢复初值')
    await result.onConfirmed?.()
    expect(remove).toHaveBeenCalledExactlyOnceWith(fresh.observation)
    expect(h.remove).not.toHaveBeenCalled()
  })

  it.each(['open-check', 'formulas'] as const)('%s 屏障失败不交初值、不清理，允许再次发现', async (reason) => {
    const h = await fixture()
    h.install.mockResolvedValue({ kind: 'blocked', reason })
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason })
    expect(h.recovery.view()).toMatchObject({ problem: reason })
    expect(h.remove).not.toHaveBeenCalled()
  })

  it.each(['preserved', 'open-check', 'formulas'] as const)('现有来源因 %s 退回阅读后，放弃绑定独立 Reader 而不是即将关闭的来源', async (reason) => {
    const h = await fixture()
    const facts = reason === 'preserved' ? { ...FACTS, current: { revision: 9, source: null, occupied: false } } : FACTS
    h.install.mockResolvedValue({ kind: 'blocked', reason })
    const oldRemove = vi.fn<RecoveryReader['remove']>().mockResolvedValue({ kind: 'failed', error: { name: 'OutboxSessionInactive', message: '来源已关闭' } })
    const existing = { ...h.original, observation: { key: KEY, id: 'session' } }
    const retire = vi.fn()
    // Worker 原来源持有 OPFS 句柄：独立 Reader 必须在其释放之后才能读到可验证的观察。
    h.observe.mockImplementation(async () => retire.mock.calls.length === 0 ? { kind: 'failed', error: { name: 'MirrorUnverified', message: '镜像句柄仍被原来源占用' } } : h.original)
    expect(await h.recovery.beginRestore()({ kind: 'existing', highWater: 37, observe: async () => existing, remove: oldRemove, retire }, facts, h.install)).toEqual({ kind: 'blocked', reason })
    expect(retire).toHaveBeenCalledOnce()
    expect(h.recovery.view().problem).toBe(reason === 'preserved' ? undefined : reason)
    const intent = h.recovery.beginDiscard()
    expect(intent).toBeDefined()
    await h.recovery.discard(intent!)
    expect(oldRemove).not.toHaveBeenCalled()
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(h.original.observation)
    expect(h.recovery.view().stage).toBe('finished')
  })

  it.each([null, { clientInstanceId: 'another-page', localSeq: 36 }])('同修订已核实的来源 %j 在阅读副本重新检查时继续有效', async (source) => {
    const h = await fixture()
    const observed = { ...h.original, record: { kind: 'draft' as const, meta: { ...h.meta, inFlight: { requestId: 'old', clientInstanceId: 'old-page', localSeq: 36, sentAt: NOW } }, gzip: await gzipBytes(new TextEncoder().encode(BODY)) } }
    h.observe.mockResolvedValue(observed)
    const verified = { ...FACTS, current: { revision: 8, source, occupied: false } }
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, verified, h.install)).toEqual({ kind: 'blocked', reason: 'preserved' })
    h.facts.mockResolvedValue({ ...verified, current: { ...verified.current, source: undefined } })
    await h.recovery.copy()
    expect(h.conflictCopy).toHaveBeenCalledOnce()
    expect(h.recovery.view().copy.kind).toBe('done')
  })

  it('独立重读已变为冲突时，即使正文相同也不沿用原恢复失败说明', async () => {
    const h = await fixture()
    h.install.mockResolvedValue({ kind: 'blocked', reason: 'open-check' })
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta: { ...h.meta, baseRevision: 6 }, gzip: await gzipBytes(new TextEncoder().encode(BODY)) } })
    expect(await h.recovery.beginRestore()({ kind: 'existing', highWater: 37, observe: async () => h.original, remove: h.remove, retire: vi.fn() }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'changed' })
    expect(h.recovery.view()).toMatchObject({ decision: { kind: 'copy', reason: 'conflict' }, problem: undefined })
  })

  it.each(['suspend', 'revision', 'explicit'] as const)('%s 后不能继续套用过去的修订来源', async (change) => {
    const h = await fixture()
    h.observe.mockResolvedValue({ ...h.original, record: { kind: 'draft', meta: { ...h.meta, inFlight: { requestId: 'old', clientInstanceId: 'old-page', localSeq: 36, sentAt: NOW } }, gzip: await gzipBytes(new TextEncoder().encode(BODY)) } })
    const verified = { ...FACTS, current: { revision: 8, source: null, occupied: false } }
    await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, verified, h.install)
    if (change === 'suspend')
      h.recovery.suspend()
    if (change === 'revision') {
      h.facts.mockResolvedValue({ ...FACTS, current: { revision: 9, source: undefined, occupied: false } })
      await h.recovery.discover()
    }
    h.facts.mockResolvedValue({ ...FACTS, current: { revision: 8, source: change === 'explicit' ? { clientInstanceId: 'old-page', localSeq: 36 } : undefined, occupied: false } })
    await h.recovery.discover()
    expect(h.recovery.view().decision).toMatchObject(change === 'explicit' ? { kind: 'restore', reason: 'own-revision' } : { kind: 'preserve', reason: 'server' })
    expect(h.conflictCopy).not.toHaveBeenCalled()
  })

  it('暂停后迟到的 SDK 初值作废；内存确认不新建观察承接旧清理', async () => {
    const h = await fixture()
    const delayed = deferred<Awaited<ReturnType<RecoveryInstall>>>()
    h.install.mockReturnValue(delayed.promise)
    const preparing = h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce())
    h.recovery.suspend()
    delayed.resolve({ kind: 'installed', capture: { snapshot: '迟到', editorSeq: 0, formulasPending: false } })
    expect(await preparing).toEqual({ kind: 'blocked', reason: 'cancelled' })
    const current = await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, async () => ({ kind: 'installed', capture: { snapshot: BODY, editorSeq: 0, formulasPending: false } }))
    if (current.kind !== 'restore')
      throw new Error('需要初值')
    const reads = h.observe.mock.calls.length
    h.recovery.suspend()
    await current.onConfirmed?.()
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.observe).toHaveBeenCalledTimes(reads)
  })

  it('旧确认的清理回包晚于新发现时，不能把新草稿标成已处理', async () => {
    const h = await fixture()
    const prepared = await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)
    if (prepared.kind !== 'restore')
      throw new Error('需要初值')
    const removed = deferred<Awaited<ReturnType<RecoveryReader['remove']>>>()
    h.remove.mockReturnValueOnce(removed.promise)
    const confirmation = prepared.onConfirmed?.()
    await vi.waitFor(() => expect(h.remove).toHaveBeenCalledOnce())
    h.observe.mockResolvedValue({ ...h.original, observation: { key: KEY, id: 'new-observation' }, record: { kind: 'draft', meta: { ...h.meta, updatedAt: NOW + 1 }, gzip: h.original.record.kind === 'draft' ? h.original.record.gzip : new Uint8Array() } })
    await h.recovery.discover()
    removed.resolve({ kind: 'removed', mirror: { kind: 'removed' } })
    await confirmation
    expect(h.recovery.view()).toMatchObject({ stage: 'ready', updatedAt: NOW + 1, decision: { kind: 'restore' } })
  })

  it('已读到新原件但仍在核对旧请求时，前一份清理迟到不能抹掉新原件存在的事实', async () => {
    const h = await fixture()
    const prepared = await h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)
    if (prepared.kind !== 'restore')
      throw new Error('需要初值')
    const removed = deferred<Awaited<ReturnType<RecoveryReader['remove']>>>()
    h.remove.mockReturnValueOnce(removed.promise)
    const confirmation = prepared.onConfirmed?.()
    const replayed = deferred<Awaited<ReturnType<typeof h.replay>>>()
    h.replay.mockReturnValueOnce(replayed.promise)
    h.observe.mockResolvedValue({ ...h.original, observation: { key: KEY, id: 'new-record' }, record: { kind: 'draft', meta: { ...h.meta, updatedAt: NOW + 1, inFlight: { requestId: 'new-request', clientInstanceId: 'old-page', localSeq: 37, sentAt: NOW } }, gzip: h.original.record.kind === 'draft' ? h.original.record.gzip : new Uint8Array() } })
    const discovering = h.recovery.discover()
    await vi.waitFor(() => expect(h.replay).toHaveBeenCalledOnce())
    removed.resolve({ kind: 'removed', mirror: { kind: 'removed' } })
    await confirmation
    replayed.reject(new NetworkError('核对未知'))
    await discovering
    h.observe.mockResolvedValue({ kind: 'unavailable', reason: 'denied' })
    expect(await h.recovery.beginRestore()({ kind: 'memory', reason: 'unavailable', highWater: 0 }, FACTS, h.install)).toEqual({ kind: 'blocked', reason: 'preserved' })
  })

  it('暂停唤醒排队的旧 prepare 时，不能重新观察或调用旧安装器', async () => {
    const h = await fixture()
    const pending = deferred<RecoveryAccessFacts>()
    h.facts.mockReturnValueOnce(pending.promise)
    const discovering = h.recovery.discover()
    await settle()
    const preparing = h.recovery.beginRestore()({ kind: 'memory', reason: 'disabled', highWater: 0 }, FACTS, h.install)
    h.recovery.suspend()
    expect(await preparing).toEqual({ kind: 'blocked', reason: 'cancelled' })
    expect(h.makeReader).not.toHaveBeenCalled()
    expect(h.install).not.toHaveBeenCalled()
    pending.resolve(FACTS)
    await discovering
  })

  it('独立会话的旧清理成功回包不能抹掉新 Reader 的失败与原凭证重试', async () => {
    const h = await fixture()
    const removed = deferred<Awaited<ReturnType<RecoveryReader['remove']>>>()
    const oldRemove = vi.fn<RecoveryReader['remove']>().mockReturnValue(removed.promise)
    const prepared = await h.recovery.beginRestore()({ kind: 'existing', highWater: 0, observe: async () => h.original, remove: oldRemove, retire: vi.fn() }, FACTS, h.install)
    if (prepared.kind !== 'restore')
      throw new Error('需要初值')
    const confirmation = prepared.onConfirmed?.()
    await vi.waitFor(() => expect(oldRemove).toHaveBeenCalledOnce())
    const observation = { key: KEY, id: 'new-corrupted' }
    h.observe.mockResolvedValue({ ...h.original, observation, record: { kind: 'draft', meta: { ...h.meta, updatedAt: NOW + 1 }, gzip: new Uint8Array([1]) } })
    h.remove.mockResolvedValueOnce({ kind: 'quota' })
    await h.recovery.discover()
    expect(h.recovery.view()).toMatchObject({ cleanup: { kind: 'quota' } })
    removed.resolve({ kind: 'removed', mirror: { kind: 'removed' } })
    await confirmation
    expect(h.recovery.view()).toMatchObject({ stage: 'ready', updatedAt: NOW + 1, cleanup: { kind: 'quota' } })
    await h.recovery.retryCleanup()
    expect(h.remove).toHaveBeenCalledTimes(2)
    expect(h.remove).toHaveBeenLastCalledWith(observation)
    expect(h.observe).toHaveBeenCalledOnce()
  })

  it('放弃确认绑定原观察，确认期间新发现不能把它改成删除新记录', async () => {
    const h = await fixture()
    await h.recovery.discover()
    const intent = h.recovery.beginDiscard()
    expect(intent).toBeDefined()
    expect(h.remove).not.toHaveBeenCalled()
    h.observe.mockResolvedValue({ ...h.original, observation: { key: KEY, id: 'new-record' } })
    await h.recovery.discover()
    h.remove.mockResolvedValue({ kind: 'changed' })
    await h.recovery.discard(intent!)
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(h.original.observation)
    expect(h.recovery.view()).toMatchObject({ cleanup: { kind: 'changed' }, problem: 'changed' })
  })

  it('放弃确认期间会话变未知不删除；提示确认只清原 at', async () => {
    const h = await fixture()
    h.notices.mockResolvedValue({ kind: 'notices', notices: [{ ...KEY, kind: 'restored', at: NOW }] })
    await h.recovery.discover()
    const intent = h.recovery.beginDiscard()!
    h.facts.mockResolvedValue({ ...FACTS, access: 'unknown' })
    await h.recovery.discard(intent)
    expect(h.remove).not.toHaveBeenCalled()
    h.facts.mockResolvedValue(FACTS)
    h.clearNotice.mockResolvedValue({ kind: 'changed' })
    await h.recovery.acknowledge(NOW)
    expect(h.clearNotice).toHaveBeenCalledExactlyOnceWith(NOW)
    expect(h.recovery.view().notice).toMatchObject({ at: NOW })
  })

  it('已认证且原文档不可读时允许条件清理，401/身份未知不走这条路', async () => {
    const h = await fixture()
    h.facts.mockResolvedValue({ ...FACTS, access: 'unreadable' })
    await h.recovery.discover()
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(h.original.observation)
    expect(h.recovery.view()).toMatchObject({ decision: { kind: 'remove', reason: 'unreadable' } })
  })
})

describe('恢复副本的唯一请求与清理', () => {
  it.each([
    ['unknown', new NetworkError('回包未知')],
    ['refused', new ApiError(422, 'SNAPSHOT_INVALID', '内容不合格')],
  ] as const)('%s 副本之后重查同一原件再明确放弃，结束旧流程并允许正常编辑', async (_kind, error) => {
    const h = await fixture()
    h.conflictCopy.mockRejectedValueOnce(error)
    await h.recovery.copy()
    h.observe.mockResolvedValue({ ...h.original, observation: { key: KEY, id: 'new-observation-same-record' } })
    await h.recovery.discover()
    await h.recovery.discard(h.recovery.beginDiscard()!)
    expect(h.recovery.view().copy).toEqual({ kind: 'idle' })
    expect(await h.recovery.beginRestore()({ kind: 'empty', highWater: 37 }, FACTS, h.install)).toEqual({ kind: 'none' })
    expect(h.conflictCopy).toHaveBeenCalledOnce()
  })

  it('明确放弃暂因 quota 失败，重试原清理成功时也释放未决副本', async () => {
    const h = await fixture()
    h.conflictCopy.mockRejectedValueOnce(new NetworkError('未知'))
    await h.recovery.copy()
    h.remove.mockResolvedValueOnce({ kind: 'quota' })
    await h.recovery.discard(h.recovery.beginDiscard()!)
    expect(h.recovery.view().copy.kind).toBe('failed')
    await h.recovery.retryCleanup()
    expect(h.recovery.view().copy.kind).toBe('idle')
    expect(await h.recovery.beginRestore()({ kind: 'empty', highWater: 37 }, FACTS, h.install)).toEqual({ kind: 'none' })
  })

  it('成功复制 A 但清理 changed，重查真正的新 B 后保留 A 链接并允许处理 B', async () => {
    const h = await fixture()
    h.remove.mockResolvedValueOnce({ kind: 'changed' })
    await h.recovery.copy()
    const nextBody = BODY.replace('原本机', '新本机')
    h.observe.mockResolvedValue({ ...h.original, observation: { key: KEY, id: 'new-record' }, record: { kind: 'draft', meta: h.meta, gzip: await gzipBytes(new TextEncoder().encode(nextBody)) } })
    await h.recovery.discover()
    expect(h.recovery.view()).toMatchObject({ copy: { kind: 'idle' }, completedCopies: [CREATED] })
    h.conflictCopy.mockResolvedValueOnce({ ...CREATED, id: 'copy-of-B' })
    await h.recovery.copy()
    expect(h.conflictCopy).toHaveBeenCalledTimes(2)
    const calls = h.conflictCopy.mock.calls as unknown as [string, { requestId: string }, Uint8Array<ArrayBuffer>][]
    expect(calls[1]![1].requestId).not.toBe(calls[0]![1].requestId)
    expect(new TextDecoder().decode(await gunzipBytes(calls[1]![2]))).toBe(nextBody)
    expect(h.recovery.view()).toMatchObject({ completedCopies: [CREATED, { ...CREATED, id: 'copy-of-B' }] })
  })

  it('同一原件仅换观察仍保留成功事实，不再创建一次副本', async () => {
    const h = await fixture()
    h.remove.mockResolvedValueOnce({ kind: 'changed' })
    await h.recovery.copy()
    h.observe.mockResolvedValue({ ...h.original, observation: { key: KEY, id: 'new-observation-same-record' } })
    await h.recovery.discover()
    await h.recovery.copy()
    expect(h.conflictCopy).toHaveBeenCalledOnce()
    expect(h.recovery.view().copy.kind).toBe('done')
  })

  it('副本 A 未决时重查并放弃新 B，仍用 A 的原请求与正文核对结果', async () => {
    const h = await fixture()
    h.conflictCopy.mockRejectedValueOnce(new NetworkError('未知'))
    await h.recovery.copy()
    const nextBody = BODY.replace('原本机', '新本机')
    h.observe.mockResolvedValue({ ...h.original, observation: { key: KEY, id: 'new-record' }, record: { kind: 'draft', meta: h.meta, gzip: await gzipBytes(new TextEncoder().encode(nextBody)) } })
    await h.recovery.discover()
    expect(h.recovery.view().copy.kind).toBe('failed')
    await h.recovery.discard(h.recovery.beginDiscard()!)
    expect(h.recovery.view().copy.kind).toBe('failed')
    await h.recovery.copy()
    const calls = h.conflictCopy.mock.calls as unknown as [string, { requestId: string }, Uint8Array<ArrayBuffer>][]
    expect(calls).toHaveLength(2)
    expect(calls[1]![1]).toBe(calls[0]![1])
    expect(calls[1]![2]).toBe(calls[0]![2])
    expect(new TextDecoder().decode(await gunzipBytes(calls[1]![2]))).toBe(BODY)
  })

  it.each(['empty', 'same', 'new'] as const)('副本明确拒绝后普通编辑能判定 %s 记录，同一原件仍须明确处理', async (kind) => {
    const h = await fixture()
    h.conflictCopy.mockRejectedValueOnce(new ApiError(422, 'SNAPSHOT_INVALID', '内容不合格'))
    await h.recovery.copy()
    if (kind === 'new') {
      const nextBody = BODY.replace('原本机', '新本机')
      h.observe.mockResolvedValue({ ...h.original, observation: { key: KEY, id: 'new-record' }, record: { kind: 'draft', meta: h.meta, gzip: await gzipBytes(new TextEncoder().encode(nextBody)) } })
    }
    const result = await h.recovery.beginRestore()(kind === 'empty' ? { kind: 'empty', highWater: 37 } : { kind: 'existing', highWater: 37, observe: h.observe, remove: h.remove, retire: vi.fn() }, FACTS, h.install)
    expect(result.kind).toBe(kind === 'empty' ? 'none' : kind === 'new' ? 'restore' : 'blocked')
    expect(h.recovery.view().copy.kind).toBe(kind === 'same' ? 'refused' : 'idle')
    expect(h.conflictCopy).toHaveBeenCalledOnce()
  })

  it.each(['done', 'refused'] as const)('暂停后已发现新 B，副本 A 迟到 %s 的核对只结束 A，不遮住或自动复制 B', async (kind) => {
    const h = await fixture()
    const response = deferred<CreatedDocument>()
    h.conflictCopy.mockReturnValueOnce(response.promise)
    const copying = h.recovery.copy()
    await vi.waitFor(() => expect(h.conflictCopy).toHaveBeenCalledOnce())
    h.recovery.suspend()
    const nextBody = BODY.replace('原本机', '新本机')
    h.observe.mockResolvedValue({ ...h.original, observation: { key: KEY, id: 'new-record' }, record: { kind: 'draft', meta: h.meta, gzip: await gzipBytes(new TextEncoder().encode(nextBody)) } })
    await h.recovery.discover()
    if (kind === 'done')
      response.resolve(CREATED)
    else
      response.reject(new ApiError(422, 'SNAPSHOT_INVALID', '旧内容不合格'))
    await copying
    expect(h.remove).not.toHaveBeenCalled()
    await h.recovery.copy()
    expect(h.recovery.view()).toMatchObject({ stage: 'ready', copy: { kind: 'idle' }, decision: { kind: 'restore' } })
    if (kind === 'done')
      expect(h.recovery.view().completedCopies).toEqual([CREATED])
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.conflictCopy).toHaveBeenCalledOnce()
    expect(h.observe).toHaveBeenCalledTimes(2)
  })

  it('恢复后加入旧在途副本的等待者，不获得分派旧认证失败的资格', async () => {
    const h = await fixture()
    const pending = deferred<CreatedDocument>()
    const error = new ApiError(401, 'UNAUTHENTICATED', '旧会话失败')
    h.conflictCopy.mockReturnValueOnce(pending.promise)
    const copying = h.recovery.copy()
    await vi.waitFor(() => expect(h.conflictCopy).toHaveBeenCalledOnce())
    h.recovery.suspend()
    const joined = h.recovery.copy()
    await settle()
    expect(h.conflictCopy).toHaveBeenCalledOnce()
    pending.reject(error)
    await Promise.all([copying, joined])
    expect(h.onSessionProblem).not.toHaveBeenCalled()
    h.conflictCopy.mockRejectedValueOnce(error)
    await h.recovery.copy()
    expect(h.onSessionProblem).toHaveBeenCalledExactlyOnceWith(error)
    expect(h.conflictCopy).toHaveBeenCalledTimes(2)
    const calls = h.conflictCopy.mock.calls as unknown as [string, unknown, Uint8Array<ArrayBuffer>][]
    expect(calls[1]![1]).toBe(calls[0]![1])
    expect(calls[1]![2]).toBe(calls[0]![2])
  })

  it.each([
    ['暂停', new ApiError(401, 'UNAUTHENTICATED', '请登录')],
    ['关闭', new ApiError(403, 'CSRF_TOKEN_INVALID', '令牌失效')],
    ['换人', new ApiError(401, 'UNAUTHENTICATED', '请登录')],
  ] as const)('%s 后迟到的副本认证失败不影响旧会话；恢复后的重试仍报告当前失败', async (action, error) => {
    const h = await fixture()
    const pending = deferred<CreatedDocument>()
    h.conflictCopy.mockReturnValueOnce(pending.promise)
    const copying = h.recovery.copy()
    await vi.waitFor(() => expect(h.conflictCopy).toHaveBeenCalledOnce())
    if (action === '关闭')
      h.recovery.dispose()
    else if (action === '换人')
      h.end()
    else
      h.recovery.suspend()
    pending.reject(error)
    await copying
    expect(h.onSessionProblem).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
    if (action === '关闭')
      return
    h.return()
    h.conflictCopy.mockRejectedValueOnce(error)
    await h.recovery.copy()
    expect(h.onSessionProblem).toHaveBeenCalledExactlyOnceWith(error)
    const calls = h.conflictCopy.mock.calls as unknown as [string, unknown, Uint8Array<ArrayBuffer>][]
    expect(calls[1]![1]).toBe(calls[0]![1])
    expect(calls[1]![2]).toBe(calls[0]![2])
  })

  it('结果未知重试沿同一正文和请求，成功但清理 changed 仍保留链接且不再新建', async () => {
    const h = await fixture()
    h.facts.mockResolvedValue({ ...FACTS, current: { revision: 10, source: null, occupied: false } })
    h.conflictCopy.mockRejectedValueOnce(new NetworkError('结果未知'))
    await h.recovery.copy()
    expect(h.recovery.view()).toMatchObject({ copy: { kind: 'failed' } })
    const before = h.observe.mock.calls.length
    h.remove.mockResolvedValue({ kind: 'changed' })
    await h.recovery.copy()
    const calls = h.conflictCopy.mock.calls as unknown as [string, { requestId: string }, Uint8Array<ArrayBuffer>][]
    expect(calls).toHaveLength(2)
    expect(calls[1]![1]).toBe(calls[0]![1])
    expect(calls[1]![2]).toBe(calls[0]![2])
    expect(new TextDecoder().decode(await gunzipBytes(calls[0]![2]))).toBe(BODY)
    expect(h.observe).toHaveBeenCalledTimes(before)
    expect(h.recovery.view()).toMatchObject({ copy: { kind: 'done', document: CREATED }, cleanup: { kind: 'changed' } })
    await h.recovery.copy()
    expect(h.conflictCopy).toHaveBeenCalledTimes(2)
  })

  it.each(['unknown', 'unreadable'] as const)('副本重试时权限为 %s，保留旧请求但不上传或清理', async (access) => {
    const h = await fixture()
    h.facts.mockResolvedValue({ ...FACTS, access: 'read-only' })
    h.conflictCopy.mockRejectedValueOnce(new NetworkError('未知'))
    await h.recovery.copy()
    h.facts.mockResolvedValue({ ...FACTS, access })
    await h.recovery.copy()
    expect(h.conflictCopy).toHaveBeenCalledTimes(1)
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('复制期间换人，迟到成功不清理；同页回来也不重发已完成的副本', async () => {
    const h = await fixture()
    h.facts.mockResolvedValue({ ...FACTS, access: 'read-only' })
    const created = deferred<CreatedDocument>()
    h.conflictCopy.mockReturnValue(created.promise)
    const copying = h.recovery.copy()
    await vi.waitFor(() => expect(h.conflictCopy).toHaveBeenCalledOnce())
    h.end()
    h.recovery.suspend()
    created.resolve(CREATED)
    await copying
    expect(h.remove).not.toHaveBeenCalled()
    h.return()
    await h.recovery.copy()
    expect(h.conflictCopy).toHaveBeenCalledTimes(1)
    expect(h.observe).toHaveBeenCalledTimes(1)
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('并发点击只创建一个副本；明确不兼容拒绝之后不继续重试', async () => {
    const h = await fixture()
    h.facts.mockResolvedValue({ ...FACTS, access: 'read-only' })
    const response = deferred<CreatedDocument>()
    h.conflictCopy.mockReturnValueOnce(response.promise)
    const first = h.recovery.copy()
    const second = h.recovery.copy()
    await settle()
    response.resolve(CREATED)
    await Promise.all([first, second])
    expect(h.conflictCopy).toHaveBeenCalledTimes(1)
    const rejected = await fixture()
    rejected.facts.mockResolvedValue({ ...FACTS, access: 'read-only' })
    rejected.conflictCopy.mockRejectedValue(new ApiError(409, 'CLIENT_OUTDATED', '页面过旧'))
    await rejected.recovery.copy()
    await rejected.recovery.copy()
    expect(rejected.conflictCopy).toHaveBeenCalledOnce()
    expect(rejected.remove).not.toHaveBeenCalled()
  })
})
