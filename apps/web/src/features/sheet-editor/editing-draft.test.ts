import type { LocalKeyHandle } from '../../shared/outbox/draft-codec.ts'
import type { LocalKeyProblem } from '../../shared/outbox/local-key.ts'
import type { LeaseVerdict } from './edit-lease.ts'
import type { EditingDraft, EditingDraftOptions } from './editing-draft.ts'
import type { OutboxHost } from './outbox/outbox-host.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../shared/api/index.ts'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, sampleMeta, USER_ID } from '../../shared/outbox/draft-record.test-support.ts'
import { fakeDraftStore } from '../../shared/outbox/draft-store.test-support.ts'
import { createDraftWriter } from '../../shared/outbox/draft-writer.ts'
import { createLocalKeyKeeper } from '../../shared/outbox/local-key.ts'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { prepareEditingDraft } from './editing-draft.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
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
