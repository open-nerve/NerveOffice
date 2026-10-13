import type { RecoveryContext, RecoveryInitialization } from '../../shared/local-drafts/recovery-initializer.ts'
import type { LocalKeyHandle } from '../../shared/outbox/draft-codec.ts'
import type { LocalKeyProblem } from '../../shared/outbox/local-key.ts'
import type { OutboxHost } from '../../shared/outbox/outbox-host.ts'
import type { LeaseVerdict } from './edit-lease.ts'
import type { EditingDraft, EditingDraftOptions } from './editing-draft.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../shared/api/index.ts'
import { createDocumentRecovery } from '../../shared/local-drafts/document-recovery.ts'
import { createDraftMirror } from '../../shared/outbox/draft-mirror.ts'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, sampleMeta, sampleStoredDraft, USER_ID } from '../../shared/outbox/draft-record.test-support.ts'
import { fakeDraftStore } from '../../shared/outbox/draft-store.test-support.ts'
import { createDraftWriter } from '../../shared/outbox/draft-writer.ts'
import { fakeLeaseClock, settle } from '../../shared/outbox/fake-lease-clock.test-support.ts'
import { createLocalKeyKeeper } from '../../shared/outbox/local-key.ts'
import { fakeMirrorDirectory } from '../../shared/outbox/mirror-directory.test-support.ts'
import { encodeSlot } from '../../shared/outbox/mirror-slot.ts'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { testSessionPermit } from '../../shared/outbox/session-fence.test-support.ts'
import { prepareEditingDraft } from './editing-draft.ts'
import { newKey } from './outbox/persistent-working-draft.test-support.ts'

const KEY = { userId: USER_ID, documentId: DOCUMENT_ID }
const cleanups: (() => void)[] = []
const capture = (snapshot: string, editorSeq = 1) => ({ snapshot, editorSeq, formulasPending: false, dedupe: true })
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup()
})

async function fixture() {
  const time = fakeLeaseClock(NOW)
  const key = await newKey(1)
  const fetch = vi.fn(async () => key)
  const keeper = createLocalKeyKeeper({ fetch, clock: time.clock, retry: { initialMs: 2_000, maxMs: 30_000 }, requestTimeoutMs: 10_000 })
  const store = fakeDraftStore()
  const hosts: OutboxHost[] = []
  const host = vi.fn(async () => {
    const writer = createDraftWriter({ store: store.store, now: time.now })
    let broken = false
    const item: OutboxHost = { kind: 'in-process', writer, broken: () => broken, dispose: vi.fn(() => {
      broken = true
      writer.dispose()
    }) }
    hosts.push(item)
    return item
  })
  const confirm = vi.fn(async (): Promise<LeaseVerdict> => ({ kind: 'current' }))
  let alive = true
  let serial = 0
  let epoch = 3
  const options: EditingDraftOptions = {
    permit: testSessionPermit,
    enabled: true,
    key: KEY,
    sessionId: 'editing-1',
    baseRevision: 7,
    format: sampleMeta().format,
    writtenBy: CLIENT_INSTANCE_ID,
    clock: time.clock,
    writeEpoch: () => epoch,
    newWriterId: () => `writer-${++serial}`,
    keeper,
    host,
    supported: () => true,
    persist: async () => ({ kind: 'denied' }),
    confirm,
    still: () => alive,
    reportError: vi.fn(),
    onSessionProblem: vi.fn(),
    onLost: vi.fn(),
  }
  function start(overrides: Partial<EditingDraftOptions> = {}) {
    const prepared = prepareEditingDraft({ ...options, ...overrides })
    cleanups.push(prepared.dispose)
    return prepared
  }
  async function ready(overrides: Partial<EditingDraftOptions> = {}): Promise<EditingDraft> {
    const result = await start(overrides).ready()
    if (result.kind !== 'ready')
      throw new Error(`需要可用来源，实际 ${result.kind}`)
    return result.draft
  }
  return {
    start,
    ready,
    options,
    key,
    keeper,
    fetch,
    store,
    hosts,
    host,
    confirm,
    time,
    end: () => { alive = false },
    epoch: (next: number) => { epoch = next },
  }
}

describe('进入编辑准备唯一内容来源', () => {
  it.each(['disabled', 'unsupported'] as const)('%s 使用内存，不取钥、不建宿主，生命周期调用也不偷偷启用', async (reason) => {
    const h = await fixture()
    const draft = await h.ready({ enabled: reason !== 'disabled', supported: () => reason !== 'unsupported' })
    expect(draft.storage()).toEqual({ kind: 'memory', reason, hostKind: undefined, mirror: undefined, persistence: undefined })
    const ref = draft.capture(capture('内存内容'))
    expect(await draft.ready(ref)).toMatchObject({ local: { kind: 'memory', reason } })
    draft.observeVersion(2)
    draft.suspend()
    await draft.resume()
    draft.discardKey()
    expect(await draft.readLatest()).toMatchObject({ snapshot: '内存内容' })
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.host).not.toHaveBeenCalled()
    expect(draft.storage()).toMatchObject({ kind: 'memory', reason })
  })

  it('存储元数据不含正文或钥，申请迟到通过原 subscribe 通知，读取未变化事实返回同一快照', async () => {
    const h = await fixture()
    const persistence = deferred<{ kind: 'denied' }>()
    const persist = vi.fn(async () => persistence.promise)
    const draft = await h.ready({ persist })
    const before = draft.storage()
    expect(before).toEqual({ kind: 'persistent', reason: undefined, hostKind: 'in-process', mirror: { kind: 'off' }, persistence: undefined })
    expect(draft.storage()).toBe(before)
    const changes = vi.fn(() => draft.storage())
    const stop = draft.subscribe(changes)
    persistence.resolve({ kind: 'denied' })
    await settle()
    expect(changes).toHaveLastReturnedWith({ ...before, persistence: { kind: 'denied' } })
    expect(persist).toHaveBeenCalledOnce()
    const ref = draft.capture(capture('不可进入元数据的正文'))
    await draft.ready(ref)
    expect(JSON.stringify(draft.storage())).not.toContain('不可进入元数据')
    stop()
    const count = changes.mock.calls.length
    draft.dispose()
    expect(changes).toHaveBeenCalledTimes(count)
    expect(draft.storage().kind).toBe('inactive')
  })

  it('当前写入配额失败时元数据说明内存退路，不继续沿用准备成功的事实', async () => {
    const h = await fixture()
    const draft = await h.ready()
    h.store.failNext('writeDraft', { kind: 'quota' })
    const ref = draft.capture(capture('写满时的修改'))
    expect(await draft.ready(ref)).toMatchObject({ local: { kind: 'memory', reason: 'quota' } })
    expect(draft.storage()).toMatchObject({ kind: 'memory', reason: 'quota', hostKind: 'in-process' })
  })

  it('新捕获写入期间保留最近的镜像事实，不退回宿主初次登记的镜像状态', async () => {
    const h = await fixture()
    const draft = await h.ready()
    const writer = h.hosts[0]!.writer
    const write = writer.write
    vi.spyOn(writer, 'write').mockImplementationOnce(async (...args) => {
      const result = await write(...args)
      return result.kind === 'written' ? { ...result, mirror: { kind: 'not-mirrored', reason: 'quota' } } : result
    })
    const first = draft.capture(capture('A'))
    await draft.ready(first)
    expect(draft.storage().mirror).toEqual({ kind: 'not-mirrored', reason: 'quota' })
    const writing = h.store.holdNext('writeDraft')
    const next = draft.capture(capture('B', 2))
    try {
      await writing.reached
      expect(draft.storage().mirror).toEqual({ kind: 'not-mirrored', reason: 'quota' })
    }
    finally {
      writing.release()
      await draft.ready(next)
    }
    expect(draft.storage().mirror).toEqual({ kind: 'off' })
  })

  it('登记就绪后才交来源，捕获使用真实持久 writer；所有权始终是同一个对象', async () => {
    const h = await fixture()
    const pending = h.start()
    const result = await pending.ready()
    expect(await pending.ready()).toBe(result)
    if (result.kind !== 'ready')
      throw new Error('需要来源')
    const draft = result.draft
    const ref = draft.capture(capture('正式来源'))
    expect(await draft.ready(ref)).toMatchObject({ contentSeq: 1, local: { kind: 'persisted' } })
    expect(h.store.rawDraft(KEY)).toMatchObject({ draftSeq: 1, keyVersion: 1, writeEpoch: 3 })
    const stop = draft.subscribe(vi.fn())
    stop()
    draft.dispose()
    pending.dispose()
    expect(h.hosts[0]!.dispose).toHaveBeenCalledOnce()
    expect(h.keeper.current()).toBeUndefined()
  })

  it.each(['dispose', 'end'] as const)('取钥期间 %s，迟到密钥不建宿主、不交来源', async (action) => {
    const h = await fixture()
    const held = deferred<LocalKeyHandle>()
    h.fetch.mockReturnValueOnce(held.promise)
    const pending = h.start()
    if (action === 'dispose')
      pending.dispose()
    else
      h.end()
    held.resolve(h.key)
    expect(await pending.ready()).toEqual({ kind: 'disposed' })
    expect(h.host).not.toHaveBeenCalled()
    expect(h.keeper.current()).toBeUndefined()
  })

  it('准备期间暂停不沿用旧资格；继续编辑前恢复会重新核对', async () => {
    const h = await fixture()
    const held = deferred<LocalKeyHandle>()
    h.fetch.mockReturnValueOnce(held.promise)
    const pending = h.start()
    pending.suspend()
    held.resolve(h.key)
    const result = await pending.ready()
    if (result.kind !== 'ready')
      throw new Error('暂停仍需要内存来源')
    const ref = result.draft.capture(capture('暂停中'))
    expect(await result.draft.ready(ref)).toMatchObject({ local: { kind: 'memory', reason: 'paused' } })
    expect(h.host).not.toHaveBeenCalled()
    await result.draft.resume()
    expect(h.confirm).toHaveBeenCalledOnce()
    expect(h.store.rawDraft(KEY)).toMatchObject({ draftSeq: 2 })
  })

  it('准备期间收到新版通知，也要挡住取钥旧回包，宿主只能装新版', async () => {
    const h = await fixture()
    const held = deferred<LocalKeyHandle>()
    h.fetch.mockReturnValueOnce(held.promise).mockResolvedValueOnce(await newKey(2))
    const pending = h.start()
    pending.observeVersion(2)
    held.resolve(h.key)
    const result = await pending.ready()
    if (result.kind !== 'ready')
      throw new Error('需要来源')
    await result.draft.ready(result.draft.capture(capture('新版才落盘')))
    expect(h.store.rawDraft(KEY)).toMatchObject({ keyVersion: 2 })
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('能力可用但暂时无钥仍给可恢复的内存来源；新捕获可以再次落盘', async () => {
    const h = await fixture()
    h.fetch.mockRejectedValueOnce(new Error('离线'))
    const draft = await h.ready()
    const ref = draft.capture(capture('无钥期间'))
    expect(await draft.ready(ref)).toMatchObject({ local: { kind: 'memory', reason: 'no-key' } })
    await h.time.advance(2_000)
    const newer = draft.capture(capture('重新联网', 2))
    expect(await draft.ready(newer)).toMatchObject({ local: { kind: 'persisted' } })
    expect(h.store.rawDraft(KEY)).toMatchObject({ draftSeq: 2 })
  })

  it('已有草稿不自动接手，保持原记录并按其高水位分配内存引用', async () => {
    const h = await fixture()
    const first = await h.ready()
    await first.ready(first.capture(capture('旧草稿')))
    const before = h.store.rawDraft(KEY)
    first.dispose()
    h.epoch(4)
    const next = await h.ready({ sessionId: 'editing-2' })
    const ref = next.capture(capture('重新打开的云端内容', 0))
    expect(ref.draftSeq).toBe(2)
    expect(await next.ready(ref)).toMatchObject({ local: { kind: 'memory', reason: 'existing-draft' } })
    expect(next.storage()).toMatchObject({ kind: 'memory', reason: 'existing-draft' })
    next.observeVersion(2)
    await next.resume()
    expect(h.store.rawDraft(KEY)).toEqual(before)
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('登记遇到明确取代只交 lost，不建立来源', async () => {
    const h = await fixture()
    const original = await h.host()
    vi.spyOn(original.writer, 'register').mockResolvedValue({ kind: 'superseded', currentEpoch: 9, sameEpoch: false })
    h.host.mockResolvedValue(original)
    h.confirm.mockResolvedValue({ kind: 'superseded', loss: { kind: 'taken-over', where: 'elsewhere' } })
    expect(await h.start().ready()).toMatchObject({ kind: 'lost', verdict: { kind: 'superseded' } })
    expect(original.dispose).toHaveBeenCalledOnce()
    expect(h.keeper.current()).toBeUndefined()
  })
})

describe('来源跟随会话和有效密钥版本', () => {
  it('正常会话的重复 resume 不重写正文，也不额外核对租约', async () => {
    const h = await fixture()
    const draft = await h.ready()
    const ref = draft.capture(capture('已就绪内容'))
    await draft.ready(ref)
    await draft.resume()
    await draft.resume()
    expect(draft.view()).toMatchObject({ ref })
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.host).toHaveBeenCalledOnce()
  })

  it('旧恢复核对挂起不能阻止新一代响应密钥版本；旧回包也不能撤新钥', async () => {
    const h = await fixture()
    const draft = await h.ready()
    const held = deferred<LeaseVerdict>()
    h.confirm.mockReturnValueOnce(held.promise)
    draft.suspend()
    const older = draft.resume()
    await settle()
    draft.suspend()
    await draft.resume()
    await draft.ready(draft.capture(capture('新一代内容')))
    h.fetch.mockResolvedValue(await newKey(2))
    draft.observeVersion(2)
    await vi.waitFor(() => expect(h.store.rawDraft(KEY)).toMatchObject({ keyVersion: 2 }))
    held.resolve({ kind: 'current' })
    await older
    expect(h.keeper.current()?.version).toBe(2)
    expect(h.store.rawDraft(KEY)).toMatchObject({ keyVersion: 2 })
    expect(h.hosts.at(-1)!.broken()).toBe(false)
  })

  it.each([2, null] as const)('自动恢复的 confirm 同步通知版本 %s，停旧钥不能晚到清掉新宿主钥', async (version) => {
    const h = await fixture()
    const draft = await h.ready()
    h.epoch(4)
    h.fetch.mockResolvedValue(await newKey(2))
    h.confirm.mockImplementationOnce(async () => {
      draft.observeVersion(version)
      return { kind: 'current' }
    })
    const ref = draft.capture(capture('第一份就落盘'))
    expect(await draft.ready(ref)).toMatchObject({ local: { kind: 'persisted' } })
    await settle()
    expect(h.store.rawDraft(KEY)).toMatchObject({ writeEpoch: 4, keyVersion: 2, draftSeq: ref.draftSeq })
    expect(await h.hosts[1]!.writer.read(KEY)).toMatchObject({ kind: 'draft' })
  })

  it.each(['ended', 'superseded'] as const)('新捕获自动恢复时发现 %s，也把裁决交给会话', async (kind) => {
    const h = await fixture()
    h.fetch.mockRejectedValueOnce(new Error('离线'))
    const draft = await h.ready()
    const verdict = { kind, loss: { kind: 'taken-over' as const, where: 'elsewhere' as const } }
    h.confirm.mockResolvedValue(verdict)
    await h.time.advance(2_000)
    const ref = draft.capture(capture('断网后修改'))
    expect(await draft.ready(ref)).toMatchObject({ local: { kind: 'memory' } })
    expect(h.options.onLost).toHaveBeenCalledExactlyOnceWith(verdict)
    expect(h.host).not.toHaveBeenCalled()
  })

  it.each([false, true])('准备完成前 resume 不丢失；随后再次暂停=%s 可以作废恢复意图', async (suspendAgain) => {
    const h = await fixture()
    const held = deferred<LocalKeyHandle>()
    h.fetch.mockReturnValueOnce(held.promise)
    const pending = h.start()
    pending.suspend()
    const resumed = pending.resume()
    if (suspendAgain)
      pending.suspend()
    held.resolve(h.key)
    const result = await pending.ready()
    await resumed
    if (result.kind !== 'ready')
      throw new Error('需要来源')
    const ref = result.draft.capture(capture('恢复后捕获'))
    expect(await result.draft.ready(ref)).toMatchObject({ local: suspendAgain ? { kind: 'memory', reason: 'paused' } : { kind: 'persisted' } })
    expect(h.confirm).toHaveBeenCalledTimes(suspendAgain ? 0 : 1)
  })

  it.each([2, null] as const)('心跳版本 %s 先停旧钥，新钥就绪后同一正文重新落盘', async (version) => {
    const h = await fixture()
    const draft = await h.ready()
    const ref = draft.capture(capture('换钥正文'))
    await draft.ready(ref)
    const held = deferred<LocalKeyHandle>()
    h.fetch.mockReturnValueOnce(held.promise)
    const notified = vi.fn()
    const stop = draft.subscribe(notified)
    draft.observeVersion(version)
    expect(h.keeper.current()).toBeUndefined()
    held.resolve(await newKey(2))
    await vi.waitFor(() => expect(h.store.rawDraft(KEY)).toMatchObject({ keyVersion: 2, draftSeq: 2 }))
    expect(draft.view()).toMatchObject({ ref: { editorSeq: ref.editorSeq, draftSeq: 2 }, local: { kind: 'persisted' } })
    expect(await draft.readLatest()).toMatchObject({ snapshot: '换钥正文' })
    expect(notified).toHaveBeenCalled()
    stop()
  })

  it('旧心跳不降版，也不制造重封与重写', async () => {
    const h = await fixture()
    h.fetch.mockResolvedValue(await newKey(3))
    const draft = await h.ready()
    const ref = draft.capture(capture('新版密钥'))
    await draft.ready(ref)
    draft.observeVersion(2)
    await settle()
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.store.rawDraft(KEY)).toMatchObject({ keyVersion: 3, draftSeq: 1 })
  })

  it('暂停后心跳不取钥，恢复才重新核对；unknown 时不恢复持久化', async () => {
    const h = await fixture()
    const draft = await h.ready()
    await draft.ready(draft.capture(capture('原内容')))
    draft.suspend()
    draft.observeVersion(2)
    await settle()
    expect(h.fetch).toHaveBeenCalledOnce()
    h.confirm.mockResolvedValue({ kind: 'unknown', error: undefined })
    await draft.resume()
    const newer = draft.capture(capture('未核对的内容', 2))
    expect(await draft.ready(newer)).toMatchObject({ local: { kind: 'memory' } })
    expect(h.host).toHaveBeenCalledOnce()
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(await draft.readLatest()).toMatchObject({ snapshot: '未核对的内容' })
  })

  it('退出清钥取消在途新钥，原正文仍可读，晚到钥不安装且不再取钥', async () => {
    const h = await fixture()
    const draft = await h.ready()
    await draft.ready(draft.capture(capture('退出时内容')))
    const held = deferred<LocalKeyHandle>()
    h.fetch.mockReturnValueOnce(held.promise)
    draft.observeVersion(2)
    draft.discardKey()
    held.resolve(await newKey(2))
    await vi.waitFor(() => expect(h.hosts[0]!.broken()).toBe(true))
    expect(h.keeper.current()).toBeUndefined()
    expect(await draft.readLatest()).toMatchObject({ snapshot: '退出时内容' })
    draft.observeVersion(3)
    await settle()
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.store.rawDraft(KEY)).toMatchObject({ keyVersion: 1 })
  })

  it('会话取钥错误交页面确认；销毁后退订，旧 key 发布不能再碰来源', async () => {
    const h = await fixture()
    const error = new ApiError(401, 'UNAUTHENTICATED', '请重新登录')
    h.fetch.mockRejectedValueOnce(error)
    const unsubscribe = vi.fn()
    const subscribe = h.keeper.subscribe
    vi.spyOn(h.keeper, 'subscribe').mockImplementation((listener) => {
      const stop = subscribe(listener)
      return () => {
        unsubscribe()
        stop()
      }
    })
    const draft = await h.ready()
    expect(h.options.onSessionProblem).toHaveBeenCalledExactlyOnceWith(error)
    draft.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    await h.keeper.ensure()
    draft.observeVersion(9)
    await draft.resume()
    expect(draft.view()).toEqual({ kind: 'disposed' })
    expect(h.host).not.toHaveBeenCalled()
  })

  it('恢复明确失效通知会话；不能把旧钥或新内容写进旧身份', async () => {
    const h = await fixture()
    const draft = await h.ready()
    draft.suspend()
    h.confirm.mockResolvedValue({ kind: 'ended', loss: { kind: 'taken-over', where: 'elsewhere' } })
    await draft.resume()
    expect(h.options.onLost).toHaveBeenCalledWith({ kind: 'ended', loss: { kind: 'taken-over', where: 'elsewhere' } })
    expect(h.host).toHaveBeenCalledOnce()
  })

  it('准备期间会话错误回调可以同步销毁；迟到结果不创建来源', async () => {
    const h = await fixture()
    const held = deferred<LocalKeyHandle | LocalKeyProblem>()
    vi.spyOn(h.keeper, 'ensure').mockReturnValueOnce(held.promise)
    const pending = h.start({ onSessionProblem: () => pending.dispose() })
    held.resolve({ kind: 'session', error: new Error('session') })
    expect(await pending.ready()).toEqual({ kind: 'disposed' })
    expect(h.host).not.toHaveBeenCalled()
  })
})

describe('恢复入口准备来源', () => {
  it.each(['key-existing', 'key-known', 'force-denied', 'force-empty', 'force-throws'] as const)('准备轮次已见原件后 %s，独立 Reader 被禁止不能误准许固定内存', async (scenario) => {
    const { h, before } = await existing()
    const local = await h.host()
    const reached = deferred<void>()
    const release = deferred<void>()
    const register = vi.spyOn(local.writer, 'register')
    if (scenario.startsWith('key-')) {
      register.mockImplementation(async () => {
        reached.resolve()
        await release.promise
        return scenario === 'key-existing'
          ? { kind: 'registered', lastDraftSeq: 37, existing: { kind: 'malformed' }, mirror: { kind: 'off' } }
          : { kind: 'unavailable', reason: 'denied', recordKnown: true }
      })
    }
    else {
      register.mockResolvedValueOnce({ kind: 'superseded', currentEpoch: 4, sameEpoch: true, recordKnown: true })
      if (scenario === 'force-denied')
        register.mockResolvedValueOnce({ kind: 'unavailable', reason: 'denied' })
      else if (scenario === 'force-empty')
        register.mockResolvedValueOnce({ kind: 'registered', lastDraftSeq: 37, existing: undefined, mirror: { kind: 'off' } })
      else
        register.mockRejectedValueOnce(new Error('第二次登记失败'))
    }
    h.host.mockResolvedValue(local)
    const observe = vi.fn(async () => ({ kind: 'unavailable', reason: 'denied' } as const))
    vi.spyOn(local.writer, 'observe').mockImplementation(observe)
    const remove = vi.fn(async () => ({ kind: 'failed', error: { name: 'UnexpectedRemove', message: '不能清理' } } as const))
    const facts = { access: 'editable', online: true, current: { revision: 7, source: null, occupied: false } } as const
    const recovery = createDocumentRecovery({
      key: KEY,
      pageFormat: h.options.format,
      writtenBy: CLIENT_INSTANCE_ID,
      clock: h.time.clock,
      now: h.time.now,
      still: () => true,
      facts: async () => facts,
      reader: () => ({ observe, refreshKey: observe, remove, notices: async () => ({ kind: 'notices', notices: [] }), clearNotice: async () => ({ kind: 'cleared' }), dispose: vi.fn() }),
      replay: async () => { throw new Error('不能重放') },
      conflictCopy: async () => { throw new Error('不能建立副本') },
      refreshCloud: async () => {},
      title: () => '原文档',
      newId: () => 'unused',
      onSessionProblem: vi.fn(),
      reportError: vi.fn(),
    })
    cleanups.push(recovery.dispose)
    const install = vi.fn(async () => ({ kind: 'blocked', reason: 'open-check' } as const))
    const pending = h.start({ recover: async context => recovery.beginRestore()(context, facts, install) })
    if (scenario.startsWith('key-')) {
      await reached.promise
      pending.observeVersion(2)
      release.resolve()
    }
    expect(await pending.ready()).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(register).toHaveBeenCalledTimes(scenario.startsWith('key-') ? 1 : 2)
    expect(observe).toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(h.store.rawDraft(KEY)).toEqual(before)
    expect(h.store.calls).not.toContain('adoptObserved')
  })

  it.each(['worker', 'in-process'] as const)('只有新版镜像而主库空，%s 的真实登记结果不能被翻译为空草稿而绕过恢复', async (kind) => {
    const h = await fixture()
    const files = fakeMirrorDirectory()
    const slot = await encodeSlot(sampleStoredDraft(), 1)
    new DataView(slot.header.buffer).setUint16(8, 99, true)
    const bytes = new Uint8Array([...slot.header, ...slot.content])
    files.putFile(KEY, 0, bytes)
    files.putFile(KEY, 1, new Uint8Array(0))
    const mirror = createDraftMirror({ directory: files.directory, clock: h.time.clock })
    const writer = createDraftWriter({ store: h.store.store, directory: files.directory, ...(kind === 'worker' ? { mirror } : {}), now: h.time.now })
    const recover = vi.fn(async (context: RecoveryContext): Promise<RecoveryInitialization> => {
      if (context.kind === 'empty')
        return { kind: 'none' }
      expect(context.kind).toBe('existing')
      if (context.kind !== 'existing')
        throw new Error('缺少受保护的恢复端口')
      expect(await context.observe()).toMatchObject({ kind: 'failed', recordKnown: true, error: { name: 'MirrorUnverified' } })
      return { kind: 'blocked', reason: 'preserved' }
    })
    const result = await h.start({ recover, host: async () => ({ kind, writer, broken: () => false, dispose: () => writer.dispose() }) }).ready()
    expect(result).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(recover).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'existing' }))
    expect(h.store.rawDraft(KEY)).toBeUndefined()
    expect(h.store.calls).not.toContain('writeDraft')
    expect(files.file(KEY, 0)).toEqual(bytes)
    expect(files.openHandles()).toBe(0)
  })

  async function existing() {
    const h = await fixture()
    const old = await h.ready()
    await old.ready(old.capture(capture('原本机正文')))
    const before = h.store.rawDraft(KEY)
    old.dispose()
    h.epoch(4)
    return { h, before }
  }

  async function initial(context: RecoveryContext): Promise<Extract<RecoveryInitialization, { kind: 'restore' }>> {
    if (context.kind !== 'existing')
      throw new Error('需要登记之后的恢复端口')
    const observed = await context.observe()
    if (observed.kind !== 'observed')
      throw new Error('观察失败')
    return { kind: 'restore', capture: { snapshot: '已打开自检的恢复正文', editorSeq: 0, formulasPending: false }, baseRevision: 8, highWater: Math.max(context.highWater, 80), recoveryObservation: observed.observation }
  }

  it('回调观察本次登记之后的事实；自检回调未完成时不采用，之后初值序号高于全部高水位', async () => {
    const { h, before } = await existing()
    const decision = deferred<RecoveryInitialization>()
    const reached = deferred<void>()
    let restore: RecoveryInitialization | undefined
    const pending = h.start({ recover: async (context) => {
      restore = await initial(context)
      reached.resolve()
      return decision.promise
    } })
    await reached.promise
    expect(h.store.rawDraft(KEY)).toEqual(before)
    expect(h.store.rawWriter(KEY)).toMatchObject({ writeEpoch: 4 })
    expect(h.store.calls).not.toContain('adoptObserved')
    decision.resolve(restore!)
    const result = await pending.ready()
    expect(result).toMatchObject({ kind: 'ready', restored: true })
    if (result.kind !== 'ready')
      throw new Error('需要来源')
    expect(result.draft.view()).toMatchObject({ kind: 'working', ref: { editorSeq: 0, draftSeq: 81 }, local: { kind: 'persisted' } })
    expect(h.store.rawDraft(KEY)).toMatchObject({ draftSeq: 81, baseRevision: 8, inFlight: null, writeEpoch: 4 })
    expect(await result.draft.readLatest()).toMatchObject({ snapshot: '已打开自检的恢复正文' })
    expect(JSON.stringify(result)).not.toContain('已打开自检的恢复正文')
  })

  it('自检/公式拒绝返回 blocked，原记录不改；不能把 none 当作绕过 existing 的许可', async () => {
    const { h, before } = await existing()
    expect(await h.start({ recover: async () => ({ kind: 'blocked', reason: 'open-check' }) }).ready()).toEqual({ kind: 'blocked', reason: 'open-check' })
    expect(h.store.rawDraft(KEY)).toEqual(before)
    expect(h.store.calls).not.toContain('adoptObserved')
    expect(await h.start({ recover: async () => ({ kind: 'none' }) }).ready()).toEqual({ kind: 'blocked', reason: 'preserved' })
    expect(h.store.rawDraft(KEY)).toEqual(before)
  })

  it('恢复检查批准固定内存退路后，存储再次可用也不登记、写入或接手未核实的旧记录', async () => {
    const { h, before } = await existing()
    const beforeWriter = h.store.rawWriter(KEY)
    h.store.failNext('registerWriter', { kind: 'unavailable', reason: 'denied' })
    const result = await h.start({ recover: async () => ({ kind: 'memory', reason: 'unavailable' }) }).ready()
    expect(result).toMatchObject({ kind: 'ready' })
    if (result.kind !== 'ready')
      throw new Error('需要固定内存来源')
    const hosts = h.host.mock.calls.length
    expect(result).not.toHaveProperty('restored')
    expect(await result.draft.ready(result.draft.capture(capture('云端内容上的新输入')))).toMatchObject({ local: { kind: 'memory', reason: 'unavailable' } })
    result.draft.suspend()
    expect(await result.draft.resume()).toBe(true)
    expect(await result.draft.ready(result.draft.capture(capture('重新确认会话后的输入', 2)))).toMatchObject({ local: { kind: 'memory', reason: 'unavailable' } })
    expect(h.host).toHaveBeenCalledTimes(hosts)
    expect(h.store.rawDraft(KEY)).toEqual(before)
    expect(h.store.rawWriter(KEY)).toEqual(beforeWriter)
    expect(h.store.calls).not.toContain('adoptObserved')
  })

  it.each(['suspend', 'dispose', 'ended'] as const)('自检尚未回来时 %s，迟到初值不采用且释放回调资源', async (cause) => {
    const { h, before } = await existing()
    const decision = deferred<RecoveryInitialization>()
    const reached = deferred<void>()
    const dispose = vi.fn()
    let restore: RecoveryInitialization | undefined
    const pending = h.start({ recover: async (context) => {
      restore = { ...await initial(context), dispose }
      reached.resolve()
      return decision.promise
    } })
    await reached.promise
    if (cause === 'suspend')
      pending.suspend()
    if (cause === 'dispose')
      pending.dispose()
    if (cause === 'ended')
      h.end()
    decision.resolve(restore!)
    expect((await pending.ready()).kind).not.toBe('ready')
    expect(h.store.rawDraft(KEY)).toEqual(before)
    expect(h.store.calls).not.toContain('adoptObserved')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('采用时发现原件已变化，阻止安装而不转内存上传覆盖它', async () => {
    const { h } = await existing()
    const newer = { replacement: '其他标签页的新内容' }
    const result = await h.start({ recover: async (context) => {
      const restore = await initial(context)
      h.store.putRaw('drafts', KEY, newer)
      return restore
    } }).ready()
    expect(result).toEqual({ kind: 'blocked', reason: 'changed' })
    expect(h.store.rawDraft(KEY)).toEqual(newer)
  })

  it('配额失败留内存；只有同来源的真实上传确认能调用原凭证清理', async () => {
    const { h, before } = await existing()
    const cleanup = vi.fn()
    const result = await h.start({ recover: async (context) => {
      const restore = await initial(context)
      if (context.kind !== 'existing')
        throw new Error('需要恢复端口')
      h.store.failNext('adoptObserved', { kind: 'quota' })
      return { ...restore, onConfirmed: async () => {
        cleanup(await context.remove(restore.recoveryObservation!))
      } }
    } }).ready()
    if (result.kind !== 'ready')
      throw new Error('内存初值仍可用')
    expect(result.restored).toBe(true)
    const view = result.draft.view()
    expect(view).toMatchObject({ kind: 'working', local: { kind: 'memory', reason: 'quota' } })
    expect(h.store.rawDraft(KEY)).toEqual(before)
    if (view.kind !== 'working')
      throw new Error('缺少初值')
    const upload = await result.draft.prepare(view.ref)
    if (upload.kind !== 'prepared')
      throw new Error('缺少上传')
    await result.draft.confirm({ ...upload }, 9)
    expect(cleanup).not.toHaveBeenCalled()
    expect(h.store.rawDraft(KEY)).toEqual(before)
    await result.draft.confirm(upload, 9)
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ kind: 'removed', mirror: { kind: 'unsupported' } })
    expect(h.store.rawDraft(KEY)).toBeUndefined()
  })

  it('采用宿主死亡后内存可用，确认不能重新 observe 或建立宿主删除旧记录', async () => {
    const { h, before } = await existing()
    const cleanup = vi.fn()
    const result = await h.start({ recover: async (context) => {
      const restore = await initial(context)
      if (context.kind !== 'existing')
        throw new Error('需要恢复端口')
      const owned = h.hosts.at(-1)!
      vi.spyOn(owned.writer, 'adopt').mockImplementationOnce(async () => {
        owned.dispose()
        return { kind: 'failed', error: { name: 'TimeoutError', message: 'Worker 超时' }, gzip: null }
      })
      return { ...restore, onConfirmed: async () => {
        cleanup(await context.remove(restore.recoveryObservation!))
      } }
    } }).ready()
    if (result.kind !== 'ready')
      throw new Error('需要内存来源')
    const view = result.draft.view()
    if (view.kind !== 'working')
      throw new Error('缺少初值')
    const hostCount = h.host.mock.calls.length
    const reads = h.store.calls.filter(call => call === 'observeDraft').length
    const upload = await result.draft.prepare(view.ref)
    if (upload.kind !== 'prepared')
      throw new Error('缺少上传')
    await result.draft.confirm(upload, 9)
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
    expect(h.host).toHaveBeenCalledTimes(hostCount)
    expect(h.store.calls.filter(call => call === 'observeDraft')).toHaveLength(reads)
    expect(h.store.calls).not.toContain('removeObserved')
    expect(h.store.rawDraft(KEY)).toEqual(before)
  })

  it.each(['quota', 'worker'] as const)('采用 %s 失败的内存来源暂停后仍能恢复上传，不重新采用或登记', async (failure) => {
    const { h } = await existing()
    const cleanup = vi.fn(async () => {})
    const result = await h.start({ recover: async (context) => {
      const restore = await initial(context)
      if (failure === 'quota') {
        h.store.failNext('adoptObserved', { kind: 'quota' })
      }
      else {
        const owned = h.hosts.at(-1)!
        vi.spyOn(owned.writer, 'adopt').mockImplementationOnce(async () => {
          owned.dispose()
          return { kind: 'failed', error: { name: 'TimeoutError', message: 'Worker 超时' }, gzip: null }
        })
      }
      return { ...restore, onConfirmed: cleanup }
    } }).ready()
    if (result.kind !== 'ready')
      throw new Error('需要来源')
    const registers = h.host.mock.calls.length
    const adoptions = h.store.calls.filter(call => call === 'adoptObserved').length
    result.draft.suspend()
    expect(await result.draft.resume()).toBe(true)
    const ref = result.draft.capture(capture('恢复联网后的输入', 1))
    expect(await result.draft.ready(ref)).toMatchObject({ kind: 'ready', local: { kind: 'memory' } })
    const upload = await result.draft.prepare(ref)
    if (upload.kind !== 'prepared')
      throw new Error('需要可上传正文')
    await result.draft.confirm(upload, 9)
    expect(cleanup).not.toHaveBeenCalled()
    expect(h.host).toHaveBeenCalledTimes(registers)
    expect(h.store.calls.filter(call => call === 'adoptObserved')).toHaveLength(adoptions)
    expect(await result.draft.readLatest()).toMatchObject({ snapshot: '恢复联网后的输入' })
  })

  it('缺钥退路恢复为内存后，不因钥匙又可用而登记新宿主破坏原观察', async () => {
    const h = await fixture()
    h.fetch.mockRejectedValueOnce(new Error('暂时取不到钥匙'))
    const result = await h.start({ recover: async (context) => {
      expect(context).toMatchObject({ kind: 'memory', reason: 'no-key' })
      return { kind: 'restore', capture: { snapshot: '独立读取器已解开的原正文', editorSeq: 0, formulasPending: false }, baseRevision: 7, highWater: 90 }
    } }).ready()
    if (result.kind !== 'ready')
      throw new Error('需要内存来源')
    await h.time.advance(2_000)
    const ref = result.draft.capture(capture('恢复后的新输入'))
    await result.draft.ready(ref)
    result.draft.suspend()
    await result.draft.resume()
    expect(h.host).not.toHaveBeenCalled()
    expect(h.store.calls).not.toContain('register')
    expect(result.draft.storage()).toMatchObject({ kind: 'memory', reason: 'no-key' })
  })

  it('部署关闭仍调用恢复入口并保持内存，销毁后的迟到确认不清理', async () => {
    const h = await fixture()
    const onConfirmed = vi.fn(async () => {})
    const dispose = vi.fn()
    const result = await h.start({ enabled: false, recover: async (context) => {
      expect(context.kind).toBe('memory')
      return { kind: 'restore', capture: { snapshot: '关闭开关后的恢复正文', editorSeq: 0, formulasPending: false }, baseRevision: 7, highWater: 90, onConfirmed, dispose }
    } }).ready()
    if (result.kind !== 'ready')
      throw new Error('需要内存来源')
    const view = result.draft.view()
    if (view.kind !== 'working')
      throw new Error('缺少初值')
    expect(view.ref.draftSeq).toBe(91)
    const upload = await result.draft.prepare(view.ref)
    if (upload.kind !== 'prepared')
      throw new Error('缺少上传')
    const confirmation = result.draft.confirm(upload, 8)
    result.draft.dispose()
    await confirmation
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(h.host).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })
})
