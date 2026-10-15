import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { InFlightSave } from '../../../shared/outbox/draft-record.ts'
import type { CaptureWritten, KeyChange, ObservedRemoveResult, ObserveResult, OpenedRecord, RegisterResult } from '../../../shared/outbox/draft-writer.ts'
import type { LocalKeyKeeper, LocalKeyProblem } from '../../../shared/outbox/local-key.ts'
import type { OutboxHost } from '../../../shared/outbox/outbox-host.ts'
import type { PersistOutcome } from '../../../shared/outbox/storage-status.ts'
import type { LeaseVerdict } from '../edit-lease.ts'
import type { OutboxSession, OutboxSessionOptions } from './outbox-session.ts'
import { describe, expect, it, vi } from 'vitest'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, sampleMeta, USER_ID, WRITER_ID } from '../../../shared/outbox/draft-record.test-support.ts'
import { fakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import { createDraftWriter } from '../../../shared/outbox/draft-writer.ts'
import { fakeLeaseClock, settle } from '../../../shared/outbox/fake-lease-clock.test-support.ts'
import { testSessionPermit } from '../../../shared/outbox/session-fence.test-support.ts'
import { prepareOutboxSession } from './outbox-session.ts'

const DRAFT = { userId: USER_ID, documentId: DOCUMENT_ID }
const REGISTERED: Extract<RegisterResult, { kind: 'registered' }> = { kind: 'registered', lastDraftSeq: 37, existing: undefined, mirror: { kind: 'off' } }
const SUPERSEDED: RegisterResult = { kind: 'superseded', currentEpoch: 9, sameEpoch: false }
const KEY_SET: KeyChange = { kind: 'key-set', notResealed: [] }
const IN_FLIGHT: InFlightSave = { requestId: WRITER_ID, clientInstanceId: CLIENT_INSTANCE_ID, localSeq: 38, sentAt: NOW }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fakeHost() {
  const writer = createDraftWriter({ store: fakeDraftStore().store, now: () => NOW })
  const bind = vi.spyOn(writer, 'bindSession')
  const register = vi.spyOn(writer, 'register').mockResolvedValue(REGISTERED)
  const setKey = vi.spyOn(writer, 'setKey').mockResolvedValue(KEY_SET)
  const write = vi.spyOn(writer, 'write').mockResolvedValue({ kind: 'written', digest: 'digest', gzip: new Uint8Array([1]), mirror: { kind: 'off' } })
  const markInFlight = vi.spyOn(writer, 'markInFlight').mockResolvedValue({ kind: 'resealed' })
  const confirm = vi.spyOn(writer, 'confirm').mockResolvedValue({ kind: 'deleted' })
  const read = vi.spyOn(writer, 'read').mockResolvedValue({ kind: 'absent' })
  const observe = vi.spyOn(writer, 'observe')
  const adopt = vi.spyOn(writer, 'adopt').mockResolvedValue({ kind: 'written', digest: 'restored', gzip: new Uint8Array([1]), mirror: { kind: 'off' } })
  const seedDigest = vi.spyOn(writer, 'seedDigest').mockResolvedValue(undefined)
  const remove = vi.spyOn(writer, 'remove')
  const dispose = vi.spyOn(writer, 'dispose')
  let broken = false
  const host: OutboxHost = { kind: 'worker', writer, broken: () => broken, dispose: () => writer.dispose() }
  return { host, bind, register, setKey, write, markInFlight, confirm, read, observe, adopt, seedDigest, remove, dispose, break: () => {
    broken = true
  } }
}

async function harness() {
  const key: LocalKeyHandle = { version: 1, key: await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt', 'decrypt']) }
  let current: LocalKeyHandle | undefined = key
  let alive = true
  let writerSerial = 0
  const ensure = vi.fn(async (): Promise<LocalKeyHandle | LocalKeyProblem> => current ?? { kind: 'unavailable', retryAt: 2_000 })
  const keeper: LocalKeyKeeper = { current: () => current, ensure, discard: () => {
    current = undefined
  }, observeVersion: () => {}, subscribe: () => () => {} }
  const local = fakeHost()
  const host = vi.fn(async (_signal: AbortSignal) => local.host)
  const confirm = vi.fn(async (): Promise<LeaseVerdict> => ({ kind: 'current' }))
  const persist = vi.fn(async (): Promise<PersistOutcome> => ({ kind: 'granted' }))
  const newWriterId = vi.fn(() => `${WRITER_ID}-${++writerSerial}`)
  const options: OutboxSessionOptions = { permit: testSessionPermit, enabled: true, key: DRAFT, writeEpoch: 3, newWriterId, keeper, confirm, host, persist, supported: () => true, still: () => alive }
  return {
    key,
    keeper,
    ensure,
    local,
    host,
    confirm,
    persist,
    newWriterId,
    options,
    changeKey: (next: LocalKeyHandle | undefined) => { current = next },
    end: () => { alive = false },
    start: (overrides: Partial<OutboxSessionOptions> = {}) => prepareOutboxSession({ ...options, ...overrides }),
  }
}

function capture() {
  return { draftSeq: 38, baseRevision: 12, writtenBy: CLIENT_INSTANCE_ID, format: sampleMeta().format, formulasPending: false, inFlight: null, bytes: new TextEncoder().encode('snapshot'), dedupe: true }
}

describe('恢复会话的显式接手资格', () => {
  const existing: OpenedRecord = { kind: 'draft', meta: sampleMeta(), gzip: new Uint8Array([1]) }
  const observation = { key: DRAFT, id: 'observed-in-host' }
  const observed: ObserveResult = { kind: 'observed', observation, record: existing, writer: { ...DRAFT, writeEpoch: 3, writerId: `${WRITER_ID}-1`, lastDraftSeq: 37, registeredAt: NOW } }
  const adoption = () => {
    const { inFlight: _inFlight, dedupe: _dedupe, ...rest } = capture()
    return rest
  }

  async function recovery(overrides: Partial<OutboxSessionOptions> = {}) {
    const h = await harness()
    h.local.register.mockResolvedValue({ ...REGISTERED, existing })
    h.local.observe.mockResolvedValue(observed)
    const session = h.start({ recoverExisting: true, ...overrides })
    expect(await session.ready()).toMatchObject({ kind: 'memory', reason: 'existing-draft' })
    return { h, session }
  }

  const busy: ObserveResult = { kind: 'failed', error: { name: 'MirrorBusy', message: '镜像仍由旧页读取' }, recordKnown: true }

  it('旧页短暂占用镜像：同一次准备等待新观察，不重登、不先开放普通写入', async () => {
    const timer = fakeLeaseClock()
    const { h, session } = await recovery({ clock: timer.clock })
    h.local.observe.mockResolvedValueOnce(busy)
    const result = session.observeRecovery()
    await settle()
    expect(await session.write(capture())).toMatchObject({ kind: 'failed' })
    expect(h.local.write).not.toHaveBeenCalled()
    await timer.advance(500)
    const ready = await result
    expect(ready).toMatchObject({ kind: 'observed', record: existing })
    expect(h.local.register).toHaveBeenCalledOnce()
    expect(h.local.setKey).toHaveBeenCalledOnce()
    expect(timer.pending()).toBe(0)
    if (ready.kind !== 'observed')
      throw new Error('需要重新观察的资格')
    expect(await session.adopt(ready.observation, adoption())).toMatchObject({ kind: 'written' })
    expect(session.view()).toMatchObject({ kind: 'ready' })
  })

  it('持续占用从首次 busy 起最多等两秒，重复 busy 不续期，之后不再观察或采用', async () => {
    const timer = fakeLeaseClock()
    const { h, session } = await recovery({ clock: timer.clock })
    h.local.observe.mockResolvedValue(busy)
    let finished = false
    const result = session.observeRecovery().then((value) => {
      finished = true
      return value
    })
    await timer.advance(1_999)
    expect(finished).toBe(false)
    await timer.advance(1)
    expect(await result).toEqual(busy)
    const attempts = h.local.observe.mock.calls.length
    await timer.advance(10_000)
    expect(h.local.observe).toHaveBeenCalledTimes(attempts)
    expect(timer.pending()).toBe(0)
    expect(await session.adopt(observation, adoption())).toMatchObject({ kind: 'failed' })
    expect(h.local.adopt).not.toHaveBeenCalled()
  })

  it('重观察挂起不能越过固定截止，之后迟到的真实成功不产生采用资格', async () => {
    const timer = fakeLeaseClock()
    const { h, session } = await recovery({ clock: timer.clock })
    const delayed = deferred<ObserveResult>()
    h.local.observe.mockResolvedValueOnce(busy).mockReturnValueOnce(delayed.promise)
    const result = session.observeRecovery()
    await timer.advance(500)
    expect(h.local.observe).toHaveBeenCalledTimes(2)
    await timer.advance(1_500)
    expect(await result).toEqual(busy)
    delayed.resolve(observed)
    await settle()
    expect(await session.adopt(observation, adoption())).toMatchObject({ kind: 'failed' })
    expect(h.local.adopt).not.toHaveBeenCalled()
    expect(session.view().kind).not.toBe('ready')
    expect(timer.pending()).toBe(0)
  })

  it.each([
    { kind: 'failed', error: { name: 'MirrorUnverified', message: '镜像有较新格式' }, recordKnown: true },
    { kind: 'failed', error: { name: 'MirrorUnreadable', message: '读取失败' }, recordKnown: true },
    { kind: 'quota', recordKnown: true },
    { kind: 'unavailable', reason: 'denied', recordKnown: true },
  ] as const)('非暂时占用 $kind 立即保留原结果，不重查或采用', async (problem) => {
    const timer = fakeLeaseClock()
    const { h, session } = await recovery({ clock: timer.clock })
    h.local.observe.mockResolvedValue(problem)
    expect(await session.observeRecovery()).toEqual(problem)
    await timer.advance(10_000)
    expect(h.local.observe).toHaveBeenCalledOnce()
    expect(h.local.adopt).not.toHaveBeenCalled()
    expect(timer.pending()).toBe(0)
  })

  it.each(['pause', 'dispose', 'key', 'epoch', 'ended', 'broken'] as const)('占用等待期间 %s，下一步不再发观察，旧结果不能接手', async (change) => {
    const timer = fakeLeaseClock()
    let epoch = 3
    const { h, session } = await recovery({ clock: timer.clock, writeEpoch: () => epoch })
    h.local.observe.mockResolvedValueOnce(busy)
    const result = session.observeRecovery()
    await settle()
    if (change === 'pause')
      session.suspend()
    if (change === 'dispose')
      session.dispose()
    if (change === 'key')
      h.changeKey(undefined)
    if (change === 'epoch')
      epoch = 4
    if (change === 'ended')
      h.end()
    if (change === 'broken')
      h.local.break()
    await timer.advance(500)
    expect(await result).toMatchObject({ kind: 'failed', error: { name: 'OutboxSessionInactive' } })
    expect(h.local.observe).toHaveBeenCalledOnce()
    expect(await session.adopt(observation, adoption())).toMatchObject({ kind: 'failed' })
    expect(h.local.adopt).not.toHaveBeenCalled()
    expect(timer.pending()).toBe(0)
  })

  it.each(['waiting', 'observing'] as const)('新观察取代占用 %s：旧调用立即结束，不能作废新调用的凭证', async (stage) => {
    const timer = fakeLeaseClock()
    const { h, session } = await recovery({ clock: timer.clock })
    h.local.observe.mockResolvedValueOnce(busy)
    const delayed = deferred<ObserveResult>()
    if (stage === 'observing')
      h.local.observe.mockReturnValueOnce(delayed.promise)
    const first = session.observeRecovery()
    await settle()
    if (stage === 'observing')
      await timer.advance(500)
    const second = await session.observeRecovery()
    expect(second.kind).toBe('observed')
    expect(await first).toMatchObject({ kind: 'failed', error: { name: 'OutboxSessionInactive' } })
    delayed.resolve(observed)
    await timer.advance(10_000)
    expect(h.local.observe).toHaveBeenCalledTimes(stage === 'observing' ? 3 : 2)
    if (second.kind !== 'observed')
      throw new Error('需要新观察')
    expect(await session.adopt(second.observation, adoption())).toMatchObject({ kind: 'written' })
    expect(timer.pending()).toBe(0)
  })

  it('重观察回包挂起时暂停立即结束等待，迟到成功不能复活资格', async () => {
    const timer = fakeLeaseClock()
    const { h, session } = await recovery({ clock: timer.clock })
    const delayed = deferred<ObserveResult>()
    h.local.observe.mockResolvedValueOnce(busy).mockReturnValueOnce(delayed.promise)
    const result = session.observeRecovery()
    await timer.advance(500)
    expect(h.local.observe).toHaveBeenCalledTimes(2)
    session.suspend()
    expect(await result).toMatchObject({ kind: 'failed', error: { name: 'OutboxSessionInactive' } })
    expect(timer.pending()).toBe(0)
    delayed.resolve(observed)
    await settle()
    expect(await session.adopt(observation, adoption())).toMatchObject({ kind: 'failed' })
    expect(h.local.adopt).not.toHaveBeenCalled()
    expect(h.local.dispose).toHaveBeenCalledOnce()
  })

  it('占用消失但登记 writer 已换，不能把新原件作为本轮恢复资格', async () => {
    const timer = fakeLeaseClock()
    const { h, session } = await recovery({ clock: timer.clock })
    h.local.observe.mockResolvedValueOnce(busy).mockResolvedValueOnce({ ...observed, writer: { ...observed.writer!, writerId: 'another-writer' } })
    const result = session.observeRecovery()
    await timer.advance(500)
    expect(await result).toMatchObject({ kind: 'failed', error: { name: 'OutboxSessionInactive' } })
    expect(session.view()).toMatchObject({ kind: 'memory', reason: 'fenced' })
    expect(h.local.adopt).not.toHaveBeenCalled()
  })

  it('显式恢复保留宿主但不开放普通写入；实际接手成功之后才进入 ready', async () => {
    const { h, session } = await recovery()
    expect(h.local.dispose).not.toHaveBeenCalled()
    expect(await session.write(capture())).toMatchObject({ kind: 'failed' })
    expect(await session.markInFlight(IN_FLIGHT)).toMatchObject({ kind: 'failed' })
    expect(await session.confirm(37, 13)).toMatchObject({ kind: 'failed' })
    expect(h.local.write).not.toHaveBeenCalled()
    const result = await session.observeRecovery()
    if (result.kind !== 'observed')
      throw new Error('缺少观察')
    expect(Object.isFrozen(result.observation)).toBe(true)
    expect(Object.isFrozen(result.observation.key)).toBe(true)
    expect(await session.adopt(result.observation, adoption())).toMatchObject({ kind: 'written' })
    expect(h.local.adopt).toHaveBeenCalledWith(result.observation, { ...adoption(), key: DRAFT, writer: { writeEpoch: 3, writerId: `${WRITER_ID}-1` } })
    expect(session.view()).toMatchObject({ kind: 'ready', lastDraftSeq: 38 })
    expect(await session.write({ ...capture(), draftSeq: 39 })).toMatchObject({ kind: 'written' })
    expect(h.local.write).toHaveBeenCalledTimes(1)
  })

  it('没有显式模式、没有观察、复制或重用凭证都不能接手', async () => {
    const { h, session } = await recovery()
    expect(await session.adopt(observation, adoption())).toMatchObject({ kind: 'failed' })
    const result = await session.observeRecovery()
    if (result.kind !== 'observed')
      throw new Error('缺少观察')
    expect(await session.adopt({ ...result.observation }, adoption())).toMatchObject({ kind: 'failed' })
    expect(h.local.adopt).not.toHaveBeenCalled()
    expect(await session.adopt(result.observation, adoption())).toMatchObject({ kind: 'written' })
    expect(await session.adopt(result.observation, adoption())).toMatchObject({ kind: 'failed' })
    const ordinary = await recovery({ recoverExisting: false })
    expect(ordinary.h.local.dispose).toHaveBeenCalledTimes(1)
    expect(await ordinary.session.observeRecovery()).toMatchObject({ kind: 'failed' })
  })

  it.each(['pause', 'dispose', 'key', 'epoch', 'ended', 'broken'] as const)('观察尚未回来时发生 %s：旧结果不再交出操作资格', async (change) => {
    let epoch = 3
    const { h, session } = await recovery({ writeEpoch: () => epoch })
    const delayed = deferred<ObserveResult>()
    h.local.observe.mockReturnValue(delayed.promise)
    const result = session.observeRecovery()
    if (change === 'pause')
      session.suspend()
    if (change === 'dispose')
      session.dispose()
    if (change === 'key')
      h.changeKey(undefined)
    if (change === 'epoch')
      epoch = 4
    if (change === 'ended')
      h.end()
    if (change === 'broken')
      h.local.break()
    delayed.resolve(observed)
    expect(await result).toMatchObject({ kind: 'failed' })
    expect(session.view().kind).not.toBe('ready')
    expect(await session.adopt(observation, adoption())).toMatchObject({ kind: 'failed' })
    expect(h.local.adopt).not.toHaveBeenCalled()
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
  })

  it.each(['pause', 'dispose', 'key', 'epoch', 'ended', 'broken'] as const)('接手尚未回来时发生 %s：迟到的 written 不开放编辑资格', async (change) => {
    let epoch = 3
    const { h, session } = await recovery({ writeEpoch: () => epoch })
    const original = await session.observeRecovery()
    if (original.kind !== 'observed')
      throw new Error('缺少观察')
    const delayed = deferred<CaptureWritten>()
    h.local.adopt.mockReturnValue(delayed.promise)
    const result = session.adopt(original.observation, adoption())
    expect(await session.adopt(original.observation, adoption())).toMatchObject({ kind: 'failed' })
    if (change === 'pause')
      session.suspend()
    if (change === 'dispose')
      session.dispose()
    if (change === 'key')
      h.changeKey(undefined)
    if (change === 'epoch')
      epoch = 4
    if (change === 'ended')
      h.end()
    if (change === 'broken')
      h.local.break()
    delayed.resolve({ kind: 'written', gzip: new Uint8Array([1]), digest: 'body', mirror: { kind: 'off' } })
    expect(await result).toMatchObject({ kind: 'failed' })
    expect(session.view().kind).not.toBe('ready')
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
  })

  it('较新的观察使晚到的旧观察失效，外来写入者不能取得本会话接手资格', async () => {
    const { h, session } = await recovery()
    const delayed = deferred<ObserveResult>()
    h.local.observe.mockReturnValueOnce(delayed.promise)
    const old = session.observeRecovery()
    const latest = await session.observeRecovery()
    delayed.resolve(observed)
    expect(await old).toMatchObject({ kind: 'failed' })
    if (latest.kind !== 'observed')
      throw new Error('缺少新观察')
    expect(await session.adopt(latest.observation, adoption())).toMatchObject({ kind: 'written' })
    const other = await recovery()
    other.h.local.observe.mockResolvedValue({ ...observed, writer: { ...DRAFT, writeEpoch: 4, writerId: 'other', lastDraftSeq: 37, registeredAt: NOW } })
    expect(await other.session.observeRecovery()).toMatchObject({ kind: 'failed' })
    expect(other.session.view()).toMatchObject({ kind: 'memory', reason: 'fenced' })
  })

  it.each(['quota', 'no-key', 'fenced'] as const)('接手失败 %s 保留原件路径，不自动重试、force 或开放普通写入', async (kind) => {
    const { h, session } = await recovery()
    const result = await session.observeRecovery()
    if (result.kind !== 'observed')
      throw new Error('缺少观察')
    h.local.adopt.mockResolvedValue(kind === 'fenced' ? { kind, reason: 'changed', gzip: new Uint8Array([1]) } : { kind, gzip: new Uint8Array([1]) })
    expect(await session.adopt(result.observation, adoption())).toMatchObject({ kind })
    expect(session.view().kind).not.toBe('ready')
    expect(await session.write(capture())).toMatchObject({ kind: 'failed' })
    expect(h.local.adopt).toHaveBeenCalledTimes(1)
    expect(h.local.register).toHaveBeenCalledTimes(1)
  })

  it.each<ObservedRemoveResult>([{ kind: 'quota' }, { kind: 'unavailable', reason: 'denied' }, { kind: 'failed', error: { name: 'AbortError', message: 'aborted' } }])('条件清理临时失败后原凭证可以重试：$kind', async (failure) => {
    const { h, session } = await recovery()
    const result = await session.observeRecovery()
    if (result.kind !== 'observed')
      throw new Error('缺少观察')
    const remove = vi.spyOn(h.local.host.writer, 'removeObserved').mockResolvedValueOnce(failure).mockResolvedValue({ kind: 'removed', mirror: { kind: 'removed' } })
    expect(await session.removeRecovery(result.observation)).toEqual(failure)
    expect(await session.removeRecovery(result.observation)).toEqual({ kind: 'removed', mirror: { kind: 'removed' } })
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('清理失败晚于暂停/新会话时不恢复旧凭证', async () => {
    const { h, session } = await recovery()
    const result = await session.observeRecovery()
    if (result.kind !== 'observed')
      throw new Error('缺少观察')
    const pending = deferred<ObservedRemoveResult>()
    const remove = vi.spyOn(h.local.host.writer, 'removeObserved').mockReturnValue(pending.promise)
    const clearing = session.removeRecovery(result.observation)
    session.suspend()
    await session.resume()
    pending.resolve({ kind: 'quota' })
    expect(await clearing).toEqual({ kind: 'quota' })
    expect(await session.removeRecovery(result.observation)).toMatchObject({ kind: 'failed', error: { name: 'OutboxSessionInactive' } })
    expect(remove).toHaveBeenCalledOnce()
  })

  it('临时接手失败后仍可凭原观察条件清理；已删除事实包含镜像失败，普通写入资格关闭', async () => {
    const { h, session } = await recovery()
    const result = await session.observeRecovery()
    if (result.kind !== 'observed')
      throw new Error('缺少观察')
    h.local.adopt.mockResolvedValue({ kind: 'quota', gzip: new Uint8Array([1]) })
    expect(await session.adopt(result.observation, adoption())).toMatchObject({ kind: 'quota' })
    const remove = vi.spyOn(h.local.host.writer, 'removeObserved').mockResolvedValue({ kind: 'removed', mirror: { kind: 'busy' } })
    expect(await session.removeRecovery({ ...result.observation })).toMatchObject({ kind: 'failed' })
    expect(remove).not.toHaveBeenCalled()
    expect(await session.removeRecovery(result.observation)).toEqual({ kind: 'removed', mirror: { kind: 'busy' } })
    expect(session.view()).toMatchObject({ kind: 'memory', reason: 'fenced' })
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
    expect(await session.removeRecovery(result.observation)).toMatchObject({ kind: 'failed' })
    expect(remove).toHaveBeenCalledTimes(1)
  })
})

describe('存储事实订阅', () => {
  it('暂停返回的旧宿主收尾晚于新准备时，不关闭新宿主或改变新写入资格', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const finish = session.suspend()
    const next = fakeHost()
    h.host.mockResolvedValueOnce(next.host)
    expect(await session.resume()).toMatchObject({ kind: 'ready' })
    finish()
    expect(h.local.dispose).toHaveBeenCalledOnce()
    expect(next.dispose).not.toHaveBeenCalled()
    expect(await session.write(capture())).toMatchObject({ kind: 'written' })
    session.dispose()
  })

  it('准备和持久保存申请分别通知；申请迟到不阻挡 ready，也不重复申请', async () => {
    const h = await harness()
    const persistence = deferred<PersistOutcome>()
    h.persist.mockReturnValue(persistence.promise)
    const session = h.start()
    const changes = vi.fn(() => ({ state: session.view(), persistence: session.persistence() }))
    const stop = session.subscribe(changes)
    await session.ready()
    expect(changes.mock.results.at(-1)?.value).toMatchObject({ state: { kind: 'ready', hostKind: 'worker' }, persistence: undefined })
    persistence.resolve({ kind: 'denied' })
    await settle()
    expect(changes.mock.results.at(-1)?.value).toMatchObject({ state: { kind: 'ready' }, persistence: { kind: 'denied' } })
    expect(h.persist).toHaveBeenCalledOnce()
    stop()
    const count = changes.mock.calls.length
    session.suspend()
    session.dispose()
    expect(changes).toHaveBeenCalledTimes(count)
  })

  it('销毁通知之后清理监听，迟到的持久保存申请不能复活状态', async () => {
    const h = await harness()
    const persistence = deferred<PersistOutcome>()
    h.persist.mockReturnValue(persistence.promise)
    const session = h.start()
    await session.ready()
    const changes = vi.fn(() => session.view())
    session.subscribe(changes)
    session.suspend()
    expect(changes).toHaveLastReturnedWith({ kind: 'memory', reason: 'paused' })
    session.dispose()
    expect(changes).toHaveLastReturnedWith({ kind: 'disposed' })
    const count = changes.mock.calls.length
    persistence.resolve({ kind: 'granted' })
    await settle()
    expect(changes).toHaveBeenCalledTimes(count)
    expect(session.persistence()).toBeUndefined()
  })
})

describe('会话清钥的两段收尾', () => {
  it('同步停写与取钥退路，允许原宿主完成临时读回，收尾只关闭宿主不删盘', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const finish = session.beginKeyDiscard()
    h.keeper.discard()
    expect(await session.write(capture())).toMatchObject({ kind: 'failed' })
    expect(await session.readRecovered()).toMatchObject({ kind: 'failed' })
    expect(h.ensure).toHaveBeenCalledOnce()
    expect(h.host).toHaveBeenCalledOnce()
    expect(await session.read()).toEqual({ kind: 'absent' })
    expect(h.local.dispose).not.toHaveBeenCalled()
    finish()
    finish()
    expect(h.local.dispose).toHaveBeenCalledOnce()
    expect(h.local.remove).not.toHaveBeenCalled()
    expect(await session.read()).toMatchObject({ kind: 'failed' })
    session.dispose()
    expect(h.local.dispose).toHaveBeenCalledOnce()
  })

  it('准备宿主尚未回来时清钥，旧宿主到达即关闭，不安装密钥或登记', async () => {
    const h = await harness()
    const creating = deferred<OutboxHost>()
    h.host.mockReturnValueOnce(creating.promise)
    const session = h.start()
    await settle()
    const finish = session.beginKeyDiscard()
    h.keeper.discard()
    finish()
    creating.resolve(h.local.host)
    expect(await session.ready()).toMatchObject({ kind: 'memory', reason: 'paused' })
    expect(h.local.dispose).toHaveBeenCalledOnce()
    expect(h.local.setKey).not.toHaveBeenCalled()
    expect(h.local.register).not.toHaveBeenCalled()
    session.dispose()
  })

  it('清钥立即关闭已经在读的 recovery，迟到正文无效', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const recovery = fakeHost()
    const reading = deferred<Awaited<ReturnType<OutboxSession['read']>>>()
    recovery.read.mockReturnValueOnce(reading.promise)
    h.host.mockResolvedValueOnce(recovery.host)
    const recovered = session.readRecovered()
    await settle()
    const finish = session.beginKeyDiscard()
    expect(recovery.dispose).toHaveBeenCalledOnce()
    reading.resolve({ kind: 'draft', meta: sampleMeta(), gzip: new Uint8Array([3]) })
    expect(await recovered).toMatchObject({ kind: 'failed' })
    finish()
    session.dispose()
    expect(recovery.dispose).toHaveBeenCalledOnce()
  })

  it('清钥撤销还在创建的 recovery，晚到宿主不能安装钥', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const recovery = fakeHost()
    const creating = deferred<OutboxHost>()
    h.host.mockReturnValueOnce(creating.promise)
    const recovered = session.readRecovered()
    await settle()
    const finish = session.beginKeyDiscard()
    creating.resolve(recovery.host)
    expect(await recovered).toMatchObject({ kind: 'failed' })
    expect(recovery.setKey).not.toHaveBeenCalled()
    expect(recovery.dispose).toHaveBeenCalledOnce()
    finish()
    session.dispose()
  })

  it('旧清理晚于新会话恢复，只关旧宿主；新宿主仍能写入', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const finish = session.beginKeyDiscard()
    h.keeper.discard()
    const next = fakeHost()
    h.changeKey({ version: 2, key: h.key.key })
    h.host.mockResolvedValue(next.host)
    expect(await session.resume()).toMatchObject({ kind: 'ready' })
    finish()
    expect(await session.write(capture())).toMatchObject({ kind: 'written' })
    expect(next.dispose).not.toHaveBeenCalled()
    expect(h.local.dispose).toHaveBeenCalledOnce()
    expect(h.confirm).toHaveBeenCalledOnce()
    session.dispose()
  })
})

describe('编辑租约代次变化', () => {
  it('取钥期间换代：初次准备作废，之后核对新代次再登记', async () => {
    const h = await harness()
    const key = deferred<LocalKeyHandle>()
    h.ensure.mockReturnValueOnce(key.promise)
    let epoch = 3
    const session = h.start({ writeEpoch: () => epoch })
    epoch = 4
    key.resolve(h.key)
    expect(await session.ready()).toMatchObject({ kind: 'memory', reason: 'fenced' })
    expect(h.host).not.toHaveBeenCalled()
    expect(await session.resume()).toMatchObject({ kind: 'ready', writer: { writeEpoch: 4 } })
    expect(h.confirm).toHaveBeenCalledOnce()
    expect(h.local.register).toHaveBeenCalledExactlyOnceWith(DRAFT, expect.objectContaining({ writeEpoch: 4 }), false)
    session.dispose()
  })

  it('旧登记回包晚于换代：关掉旧宿主，不发布 ready；重新准备保持登记高水位', async () => {
    const h = await harness()
    const registering = deferred<RegisterResult>()
    h.local.register.mockReturnValueOnce(registering.promise)
    let epoch = 3
    const session = h.start({ writeEpoch: () => epoch })
    await settle()
    expect(h.local.register).toHaveBeenCalledOnce()
    epoch = 4
    registering.resolve(REGISTERED)
    expect(await session.ready()).toMatchObject({ kind: 'memory', reason: 'fenced' })
    expect(h.local.dispose).toHaveBeenCalledOnce()
    const next = fakeHost()
    h.host.mockResolvedValue(next.host)
    expect(await session.resume()).toMatchObject({ kind: 'ready', writer: { writeEpoch: 4 }, lastDraftSeq: 37 })
    expect(next.register).toHaveBeenCalledExactlyOnceWith(DRAFT, expect.objectContaining({ writeEpoch: 4 }), false)
    session.dispose()
  })

  it('已准备后换代：旧身份不能再写、标记、确认、重封或 seed，保留临时读回', async () => {
    const h = await harness()
    let epoch = 3
    const session = h.start({ writeEpoch: () => epoch })
    await session.ready()
    epoch = 4
    expect(session.view()).toMatchObject({ kind: 'memory', reason: 'fenced', lastDraftSeq: 37 })
    expect(await session.write(capture())).toMatchObject({ kind: 'failed' })
    expect(await session.markInFlight(IN_FLIGHT)).toMatchObject({ kind: 'failed' })
    expect(await session.confirm(38, 13)).toMatchObject({ kind: 'failed' })
    expect(await session.setKey(h.key)).toMatchObject({ kind: 'failed' })
    expect(await session.refreshKey()).toEqual({ kind: 'no-host' })
    await session.seedDigest({ digest: 'late', formulasPending: false })
    expect(h.local.write).not.toHaveBeenCalled()
    expect(h.local.markInFlight).not.toHaveBeenCalled()
    expect(h.local.confirm).not.toHaveBeenCalled()
    expect(h.local.seedDigest).not.toHaveBeenCalled()
    expect(h.local.setKey).toHaveBeenCalledOnce()
    expect(await session.read()).toEqual({ kind: 'absent' })
    session.dispose()
  })

  it('换钥回包期间换代，旧回包不能重新给宿主写入资格', async () => {
    const h = await harness()
    let epoch = 3
    const session = h.start({ writeEpoch: () => epoch })
    await session.ready()
    const changing = deferred<KeyChange>()
    h.local.setKey.mockReturnValueOnce(changing.promise)
    const key = session.setKey(h.key)
    epoch = 4
    changing.resolve(KEY_SET)
    expect(await key).toMatchObject({ kind: 'failed' })
    expect(session.view()).toMatchObject({ kind: 'memory', reason: 'fenced' })
    expect(await session.write(capture())).toMatchObject({ kind: 'failed' })
    expect(h.local.write).not.toHaveBeenCalled()
    session.dispose()
  })
})

describe('发件箱写入资格准备', () => {
  it('取钥、建宿主、设钥、登记按顺序完成；绑定文档与新写入身份，交回真实高水位', async () => {
    const h = await harness()
    const session = h.start()
    const ready = await session.ready()
    expect(ready).toEqual({ kind: 'ready', writer: { writeEpoch: 3, writerId: `${WRITER_ID}-1` }, lastDraftSeq: 37, mirror: { kind: 'off' }, hostKind: 'worker' })
    expect(h.ensure.mock.invocationCallOrder[0]).toBeLessThan(h.host.mock.invocationCallOrder[0] ?? 0)
    expect(h.host.mock.invocationCallOrder[0]).toBeLessThan(h.local.setKey.mock.invocationCallOrder[0] ?? 0)
    expect(h.local.setKey.mock.invocationCallOrder[0]).toBeLessThan(h.local.register.mock.invocationCallOrder[0] ?? 0)
    expect(h.local.register).toHaveBeenCalledExactlyOnceWith(DRAFT, { writeEpoch: 3, writerId: `${WRITER_ID}-1` }, false)
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.persist).toHaveBeenCalledTimes(1)
    const content = capture()
    await session.write(content)
    await session.markInFlight(IN_FLIGHT)
    await session.confirm(38, 13)
    await session.seedDigest({ digest: 'seed', formulasPending: false })
    expect(h.local.write).toHaveBeenCalledWith({ ...content, key: DRAFT, writer: { writeEpoch: 3, writerId: `${WRITER_ID}-1` } })
    expect(h.local.write.mock.calls[0]?.[0]).not.toHaveProperty('adoptSeq')
    expect(h.local.markInFlight).toHaveBeenCalledWith(DRAFT, { writeEpoch: 3, writerId: `${WRITER_ID}-1` }, IN_FLIGHT)
    expect(h.local.confirm).toHaveBeenCalledWith(DRAFT, { writeEpoch: 3, writerId: `${WRITER_ID}-1` }, 38, 13)
    expect(h.local.seedDigest).toHaveBeenCalledWith(DRAFT, { digest: 'seed', formulasPending: false })
    session.dispose()
  })

  it.each([
    { enabled: false, supported: true, reason: 'disabled' },
    { enabled: true, supported: false, reason: 'unsupported' },
  ])('$reason 不取钥、不建宿主、不申请 persist，也不登记或删除旧记录', async ({ enabled, supported, reason }) => {
    const h = await harness()
    const session = h.start({ enabled, supported: () => supported })
    expect(await session.ready()).toEqual({ kind: 'memory', reason })
    expect(await session.resume()).toEqual({ kind: 'memory', reason })
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.host).not.toHaveBeenCalled()
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.newWriterId).not.toHaveBeenCalled()
    expect(h.local.remove).not.toHaveBeenCalled()
    expect(h.confirm).not.toHaveBeenCalled()
    session.dispose()
  })

  it.each<PersistOutcome>([{ kind: 'denied' }, { kind: 'unsupported' }, { kind: 'failed', error: { name: 'Error', message: '拒绝' } }])('persist $kind 不阻止编辑；暂停、恢复、换钥不重复申请', async (outcome) => {
    const h = await harness()
    h.persist.mockResolvedValue(outcome)
    const session = h.start()
    expect(await session.ready()).toMatchObject({ kind: 'ready' })
    expect(session.persistence()).toEqual(outcome)
    session.suspend()
    const next = fakeHost()
    h.host.mockResolvedValue(next.host)
    expect(await session.resume()).toMatchObject({ kind: 'ready' })
    await session.setKey(h.key)
    expect(h.persist).toHaveBeenCalledTimes(1)
    expect(h.confirm).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('persist 等用户决定不阻塞准备；销毁后的结果不会重新发布事实', async () => {
    const h = await harness()
    const decision = deferred<PersistOutcome>()
    h.persist.mockReturnValue(decision.promise)
    const session = h.start()
    expect(await session.ready()).toMatchObject({ kind: 'ready' })
    expect(session.persistence()).toBeUndefined()
    session.dispose()
    decision.resolve({ kind: 'granted' })
    await settle()
    expect(session.persistence()).toBeUndefined()
    expect(session.view()).toEqual({ kind: 'disposed' })
  })

  it.each(['locks', 'crypto'] as const)('默认能力探测缺少 %s 时不启动持久化，不依赖调用方声明', async (missing) => {
    const h = await harness()
    const { supported: _supported, ...options } = h.options
    try {
      vi.stubGlobal(missing === 'locks' ? 'navigator' : 'crypto', {})
      const session = prepareOutboxSession(options)
      expect(await session.ready()).toEqual({ kind: 'memory', reason: 'unsupported' })
      expect(h.ensure).not.toHaveBeenCalled()
      expect(h.host).not.toHaveBeenCalled()
      expect(h.persist).not.toHaveBeenCalled()
      session.dispose()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('persist 同步抛错仍只记失败，不使准备失败或重复申请', async () => {
    const h = await harness()
    h.persist.mockImplementation(() => {
      throw new Error('存储被拒绝')
    })
    const session = h.start()
    expect(await session.ready()).toMatchObject({ kind: 'ready' })
    expect(session.persistence()).toEqual({ kind: 'failed', error: { name: 'Error', message: '存储被拒绝' } })
    expect(h.persist).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it.each<LocalKeyProblem>([{ kind: 'unavailable', retryAt: 2_000 }, { kind: 'session', error: new Error('登录过期') }, { kind: 'discarded' }])('取钥 $kind 保留具体原因，不建宿主', async (problem) => {
    const h = await harness()
    h.ensure.mockResolvedValue(problem)
    const session = h.start()
    expect(await session.ready()).toEqual({ kind: 'memory', reason: 'no-key', keyProblem: problem })
    expect(h.host).not.toHaveBeenCalled()
    session.dispose()
  })

  it('取钥完成后已被停用，不能给新宿主装回旧钥', async () => {
    const h = await harness()
    h.ensure.mockImplementation(async () => {
      h.changeKey(undefined)
      return h.key
    })
    const session = h.start()
    expect(await session.ready()).toEqual({ kind: 'memory', reason: 'no-key' })
    expect(h.host).not.toHaveBeenCalled()
    session.dispose()
  })

  it.each<OpenedRecord>([
    { kind: 'draft', meta: sampleMeta(), gzip: new Uint8Array([1]) },
    { kind: 'no-key', meta: sampleMeta() },
    { kind: 'unreadable', meta: sampleMeta(), reason: 'corrupted' },
    { kind: 'newer-format', recordVersion: 99 },
    { kind: 'malformed' },
  ])('登记已有 $kind 草稿：保留原记录，关闭宿主，用内存而不 adopt', async (existing) => {
    const h = await harness()
    h.local.register.mockResolvedValue({ kind: 'registered', lastDraftSeq: 37, existing, mirror: { kind: 'off' } })
    const session = h.start()
    const summary = existing.kind === 'draft' ? { kind: 'draft', meta: existing.meta } : existing
    expect(await session.ready()).toEqual({ kind: 'memory', reason: 'existing-draft', existing: summary, lastDraftSeq: 37, recordKnown: true })
    expect(session.view()).toEqual({ kind: 'memory', reason: 'existing-draft', existing: summary, lastDraftSeq: 37, recordKnown: true })
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
    expect(h.local.write).not.toHaveBeenCalled()
    expect(h.local.remove).not.toHaveBeenCalled()
    expect(h.local.confirm).not.toHaveBeenCalled()
    session.dispose()
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
  })

  it('登记被本机栅栏拒绝，只有服务端 current 才以又一个新 writerId force；只尝试一次', async () => {
    const h = await harness()
    h.local.register.mockResolvedValueOnce(SUPERSEDED)
    const session = h.start()
    expect(await session.ready()).toMatchObject({ kind: 'ready', writer: { writeEpoch: 3, writerId: `${WRITER_ID}-2` } })
    expect(h.local.register.mock.calls).toEqual([
      [DRAFT, { writeEpoch: 3, writerId: `${WRITER_ID}-1` }, false],
      [DRAFT, { writeEpoch: 3, writerId: `${WRITER_ID}-2` }, true],
    ])
    expect(h.local.register.mock.invocationCallOrder[0]).toBeLessThan(h.confirm.mock.invocationCallOrder[0] ?? 0)
    expect(h.confirm.mock.invocationCallOrder[0]).toBeLessThan(h.local.register.mock.invocationCallOrder[1] ?? 0)
    session.dispose()
  })

  it.each<LeaseVerdict>([
    { kind: 'unknown', error: new Error('断网') },
    { kind: 'ended', loss: undefined },
    { kind: 'superseded', loss: { kind: 'taken-over', where: 'elsewhere' } },
  ])('登记拒绝后服务端 $kind 不能 force，失效裁决原样交回', async (verdict) => {
    const h = await harness()
    h.local.register.mockResolvedValue(SUPERSEDED)
    h.confirm.mockResolvedValue(verdict)
    const session = h.start()
    expect(await session.ready()).toEqual(verdict.kind === 'unknown' ? { kind: 'memory', reason: 'fenced', verdict } : { kind: 'lost', verdict })
    expect(h.local.register).toHaveBeenCalledTimes(1)
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('force 后仍被拒绝不循环核对、登记', async () => {
    const h = await harness()
    h.local.register.mockResolvedValue(SUPERSEDED)
    const session = h.start()
    expect(await session.ready()).toEqual({ kind: 'memory', reason: 'fenced' })
    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.local.register).toHaveBeenCalledTimes(2)
    session.dispose()
  })

  it.each([
    { outcome: { kind: 'quota' } as const, reason: 'quota' },
    { outcome: { kind: 'unavailable', reason: 'newer-version' } as const, reason: 'unavailable' },
    { outcome: { kind: 'failed', error: { name: 'MirrorUnreadable', message: '不能比对' } } as const, reason: 'unavailable' },
  ])('登记 $reason 保留具体存储问题并关闭宿主', async ({ outcome, reason }) => {
    const h = await harness()
    h.local.register.mockResolvedValue(outcome)
    const session = h.start()
    expect(await session.ready()).toEqual({ kind: 'memory', reason, problem: outcome })
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
    session.dispose()
  })
})

describe('暂停和销毁不被晚到准备复活', () => {
  const stages = ['key', 'host', 'set-key', 'register', 'confirm', 'force'] as const
  const actions = ['suspend', 'dispose', 'end'] as const
  for (const stage of stages) {
    it.each(actions)(`${stage} 等待中 %s，晚到不能开始下一段或启用写入`, async (action) => {
      const h = await harness()
      const key = deferred<LocalKeyHandle>()
      const host = deferred<OutboxHost>()
      const setKey = deferred<KeyChange>()
      const register = deferred<RegisterResult>()
      const confirm = deferred<LeaseVerdict>()
      if (stage === 'key')
        h.ensure.mockReturnValue(key.promise)
      if (stage === 'host')
        h.host.mockReturnValue(host.promise)
      if (stage === 'set-key')
        h.local.setKey.mockReturnValue(setKey.promise)
      if (stage === 'register')
        h.local.register.mockReturnValue(register.promise)
      if (stage === 'confirm') {
        h.local.register.mockResolvedValue(SUPERSEDED)
        h.confirm.mockReturnValue(confirm.promise)
      }
      if (stage === 'force')
        h.local.register.mockResolvedValueOnce(SUPERSEDED).mockReturnValue(register.promise)
      const session = h.start()
      await settle()
      const calls = h.local.register.mock.calls.length
      if (action === 'end')
        h.end()
      else session[action]()
      key.resolve(h.key)
      host.resolve(h.local.host)
      setKey.resolve(KEY_SET)
      register.resolve({ ...REGISTERED, recordKnown: true })
      confirm.resolve({ kind: 'current' })
      expect(await session.ready()).toEqual(action === 'suspend' ? { kind: 'memory', reason: 'paused' } : { kind: 'disposed' })
      expect(session.view()).toEqual(action === 'suspend' ? { kind: 'memory', reason: 'paused' } : { kind: 'disposed' })
      expect(h.local.register).toHaveBeenCalledTimes(calls)
      if (stage !== 'key')
        expect(h.local.dispose).toHaveBeenCalledTimes(1)
      else expect(h.host).not.toHaveBeenCalled()
      expect(await session.write(capture())).toMatchObject({ kind: 'failed', gzip: null })
      expect(h.local.write).not.toHaveBeenCalled()
      session.dispose()
    })
  }

  it('暂停同步阻止写入、确认、重封和换钥；可读原内容给内存退路，销毁后读也停止', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    session.suspend()
    await session.write(capture())
    await session.markInFlight(IN_FLIGHT)
    await session.confirm(38, 13)
    await session.setKey(h.key)
    await session.seedDigest({ digest: 'seed', formulasPending: false })
    expect(h.local.write).not.toHaveBeenCalled()
    expect(h.local.markInFlight).not.toHaveBeenCalled()
    expect(h.local.confirm).not.toHaveBeenCalled()
    expect(h.local.setKey).toHaveBeenCalledTimes(1)
    expect(h.local.seedDigest).not.toHaveBeenCalled()
    expect(await session.read()).toEqual({ kind: 'absent' })
    expect(h.local.read).toHaveBeenCalledTimes(1)
    session.dispose()
    session.dispose()
    expect(await session.read()).toMatchObject({ kind: 'failed' })
    expect(h.local.read).toHaveBeenCalledTimes(1)
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
  })

  it('恢复先核对服务端，并发调用共用一次准备；旧准备晚到不能清掉新的 pending', async () => {
    const h = await harness()
    const firstKey = deferred<LocalKeyHandle>()
    h.ensure.mockReturnValueOnce(firstKey.promise)
    const session = h.start()
    session.suspend()
    const judgment = deferred<LeaseVerdict>()
    h.confirm.mockReturnValue(judgment.promise)
    const first = session.resume()
    firstKey.resolve(h.key)
    expect(await session.ready()).toEqual({ kind: 'memory', reason: 'paused' })
    const second = session.resume()
    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.host).not.toHaveBeenCalled()
    judgment.resolve({ kind: 'current' })
    expect(await first).toMatchObject({ kind: 'ready' })
    expect(await second).toEqual(await first)
    expect(h.host).toHaveBeenCalledTimes(1)
    expect(h.ensure).toHaveBeenCalledTimes(2)
    session.dispose()
  })

  it.each<LeaseVerdict>([{ kind: 'unknown', error: undefined }, { kind: 'ended', loss: undefined }])('恢复核对 $kind 时不建立新宿主', async (verdict) => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    session.suspend()
    h.confirm.mockResolvedValue(verdict)
    expect(await session.resume()).toEqual(verdict.kind === 'unknown' ? { kind: 'memory', reason: 'fenced', verdict } : { kind: 'lost', verdict })
    expect(h.host).toHaveBeenCalledTimes(1)
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('运行中宿主坏了只报告失败，显式 resume 才核对并准备一次新宿主', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    h.local.break()
    expect(session.view()).toEqual({ kind: 'memory', reason: 'worker-failed' })
    await session.write(capture())
    await session.confirm(38, 13)
    expect(h.host).toHaveBeenCalledTimes(1)
    expect(h.local.write).not.toHaveBeenCalled()
    expect(h.local.confirm).not.toHaveBeenCalled()
    const next = fakeHost()
    h.host.mockResolvedValue(next.host)
    expect(await session.resume()).toMatchObject({ kind: 'ready', writer: { writerId: `${WRITER_ID}-2` } })
    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.host).toHaveBeenCalledTimes(2)
    session.dispose()
  })
})

describe('换钥只安装仍属于当前会话的版本', () => {
  it.each(['host', 'set-key', 'register', 'confirm', 'force'] as const)('准备 %s 等待期间 keeper 换钥，旧准备不登记或启用写入', async (stage) => {
    const h = await harness()
    const host = deferred<OutboxHost>()
    const setKey = deferred<KeyChange>()
    const register = deferred<RegisterResult>()
    const confirm = deferred<LeaseVerdict>()
    if (stage === 'host')
      h.host.mockReturnValue(host.promise)
    if (stage === 'set-key')
      h.local.setKey.mockReturnValue(setKey.promise)
    if (stage === 'register')
      h.local.register.mockReturnValue(register.promise)
    if (stage === 'confirm') {
      h.local.register.mockResolvedValue(SUPERSEDED)
      h.confirm.mockReturnValue(confirm.promise)
    }
    if (stage === 'force')
      h.local.register.mockResolvedValueOnce(SUPERSEDED).mockReturnValue(register.promise)
    const session = h.start()
    await settle()
    const calls = h.local.register.mock.calls.length
    h.changeKey({ ...h.key, version: 2 })
    host.resolve(h.local.host)
    setKey.resolve(KEY_SET)
    register.resolve(REGISTERED)
    confirm.resolve({ kind: 'current' })
    expect(await session.ready()).toEqual({ kind: 'memory', reason: 'no-key' })
    expect(h.local.register).toHaveBeenCalledTimes(calls)
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
    await session.write(capture())
    expect(h.local.write).not.toHaveBeenCalled()
    session.dispose()
  })

  it('keeper 已停用旧钥但新钥尚未 set：立即停写；不能把晚到旧 handle 装回', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    h.changeKey(undefined)
    await session.write(capture())
    expect(h.local.write).not.toHaveBeenCalled()
    expect(session.view()).toEqual({ kind: 'memory', reason: 'no-key' })
    expect(await session.setKey(h.key)).toMatchObject({ kind: 'failed' })
    expect(h.local.setKey).toHaveBeenCalledTimes(1)
    await session.setKey(undefined)
    expect(h.local.setKey).toHaveBeenLastCalledWith(undefined)
    const next = { ...h.key, version: 2 }
    h.changeKey(next)
    h.local.setKey.mockResolvedValue({ kind: 'key-set', notResealed: [DRAFT] })
    expect(await session.setKey(next)).toEqual({ kind: 'key-set', notResealed: [DRAFT] })
    expect(session.view()).toMatchObject({ kind: 'ready' })
    await session.write(capture())
    expect(h.local.write).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it.each(['suspend', 'dispose'] as const)('换钥途中 %s，晚到成功不重新启用写入', async (action) => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const next = { ...h.key, version: 2 }
    h.changeKey(next)
    const changed = deferred<KeyChange>()
    h.local.setKey.mockReturnValue(changed.promise)
    const pending = session.setKey(next)
    session[action]()
    changed.resolve(KEY_SET)
    expect(await pending).toMatchObject({ kind: 'failed' })
    await session.write(capture())
    expect(h.local.write).not.toHaveBeenCalled()
    session.dispose()
  })

  it('旧 setKey 完成晚于新 setKey，不覆盖新版本的写入资格', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const second = { ...h.key, version: 2 }
    const third = { ...h.key, version: 3 }
    h.changeKey(second)
    const older = deferred<KeyChange>()
    h.local.setKey.mockReturnValueOnce(older.promise)
    const old = session.setKey(second)
    h.changeKey(third)
    expect(await session.setKey(third)).toEqual(KEY_SET)
    older.resolve(KEY_SET)
    expect(await old).toMatchObject({ kind: 'failed' })
    expect(session.view()).toMatchObject({ kind: 'ready' })
    await session.write(capture())
    expect(h.local.write).toHaveBeenCalledTimes(1)
    session.dispose()
  })
})

describe('运行中的栅栏拒绝立即停用写入资格', () => {
  it.each(['write', 'markInFlight', 'confirm'] as const)('%s 被拒绝后不再持久写，resume 必须向服务端核对', async (method) => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const result = { kind: 'fenced', reason: 'not-writer' } as const
    if (method === 'write') {
      h.local.write.mockResolvedValue({ ...result, gzip: new Uint8Array([1]) })
      expect(await session.write(capture())).toMatchObject(result)
    }
    if (method === 'markInFlight') {
      h.local.markInFlight.mockResolvedValue(result)
      expect(await session.markInFlight(IN_FLIGHT)).toEqual(result)
    }
    if (method === 'confirm') {
      h.local.confirm.mockResolvedValue(result)
      expect(await session.confirm(38, 13)).toEqual(result)
    }
    expect(session.view()).toEqual({ kind: 'memory', reason: 'fenced' })
    const before = h.local.write.mock.calls.length
    expect(await session.write(capture())).toMatchObject({ kind: 'failed' })
    expect(h.local.write).toHaveBeenCalledTimes(before)
    h.confirm.mockResolvedValue({ kind: 'unknown', error: undefined })
    expect(await session.resume()).toEqual({ kind: 'memory', reason: 'fenced', verdict: { kind: 'unknown', error: undefined } })
    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.host).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('旧宿主的 fenced 晚于恢复成功，不能停掉新身份', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const old = deferred<Awaited<ReturnType<OutboxSession['write']>>>()
    h.local.write.mockReturnValue(old.promise)
    const pending = session.write(capture())
    session.suspend()
    const next = fakeHost()
    h.host.mockResolvedValue(next.host)
    await session.resume()
    old.resolve({ kind: 'fenced', reason: 'not-writer', gzip: new Uint8Array([1]) })
    expect(await pending).toMatchObject({ kind: 'fenced' })
    expect(session.view()).toMatchObject({ kind: 'ready', writer: { writerId: `${WRITER_ID}-2` } })
    await session.write(capture())
    expect(next.write).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it.each(['unknown', 'ended'] as const)('崩溃后的只读恢复不依赖编辑权 %s，也不登记、force、persist 或启用写入', async (verdict) => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    h.local.break()
    h.confirm.mockResolvedValue(verdict === 'unknown' ? { kind: 'unknown', error: undefined } : { kind: 'ended', loss: undefined })
    expect(await session.resume()).toMatchObject(verdict === 'unknown' ? { kind: 'memory' } : { kind: 'lost' })
    const next = fakeHost()
    const content = { kind: 'draft' as const, meta: sampleMeta(), gzip: new Uint8Array([1, 2]) }
    next.read.mockResolvedValue(content)
    h.host.mockResolvedValue(next.host)
    const before = session.view()
    expect(await session.readRecovered()).toBe(content)
    expect(next.setKey).toHaveBeenCalledExactlyOnceWith(h.key)
    expect(next.read).toHaveBeenCalledExactlyOnceWith(DRAFT)
    expect(next.register).not.toHaveBeenCalled()
    expect(next.write).not.toHaveBeenCalled()
    expect(next.dispose).toHaveBeenCalledTimes(1)
    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.persist).toHaveBeenCalledTimes(1)
    expect(session.view()).toEqual(before)
    session.dispose()
  })

  it.each(['disabled', 'unsupported'] as const)('只读恢复尊重 %s：不取钥、不创建宿主', async (reason) => {
    const h = await harness()
    const session = h.start({ enabled: reason !== 'disabled', supported: () => reason !== 'unsupported' })
    await session.ready()
    expect(await session.readRecovered()).toMatchObject({ kind: 'failed' })
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.host).not.toHaveBeenCalled()
    session.dispose()
  })

  it('只读恢复中 dispose 关闭临时宿主，晚到正文不交回', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const next = fakeHost()
    const read = deferred<Awaited<ReturnType<OutboxSession['read']>>>()
    next.read.mockReturnValue(read.promise)
    h.host.mockResolvedValue(next.host)
    const result = session.readRecovered()
    await settle()
    expect(next.read).toHaveBeenCalledTimes(1)
    session.dispose()
    expect(next.dispose).toHaveBeenCalledTimes(1)
    read.resolve({ kind: 'draft', meta: sampleMeta(), gzip: new Uint8Array([3]) })
    expect(await result).toMatchObject({ kind: 'failed' })
    expect(next.dispose).toHaveBeenCalledTimes(1)
  })

  it('仍持有原宿主时重新取钥只换钥，不重新登记或关闭其内容缓存', async () => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    h.changeKey(undefined)
    await session.setKey(undefined)
    const next: LocalKeyHandle = { version: 2, key: h.key.key }
    h.ensure.mockImplementation(async () => {
      h.changeKey(next)
      return next
    })
    expect(await session.refreshKey()).toEqual({ kind: 'key-set', notResealed: [] })
    expect(session.view()).toMatchObject({ kind: 'ready' })
    expect(h.local.register).toHaveBeenCalledTimes(1)
    expect(h.host).toHaveBeenCalledTimes(1)
    expect(h.local.dispose).not.toHaveBeenCalled()
    expect(h.confirm).not.toHaveBeenCalled()
    session.dispose()
  })

  it.each(['suspend', 'dispose', 'key-changed'] as const)('重取钥期间 %s，迟到结果不能启用旧宿主', async (stop) => {
    const h = await harness()
    const session = h.start()
    await session.ready()
    const held = deferred<LocalKeyHandle | LocalKeyProblem>()
    h.ensure.mockReturnValueOnce(held.promise)
    const refreshed = session.refreshKey()
    if (stop === 'suspend')
      session.suspend()
    else if (stop === 'dispose')
      session.dispose()
    else
      h.changeKey({ version: 2, key: h.key.key })
    held.resolve(h.key)
    expect(await refreshed).toMatchObject({ kind: 'failed' })
    expect(h.local.setKey).toHaveBeenCalledTimes(1)
    session.dispose()
  })
})

describe('异步编辑准备不借后来登录的许可', () => {
  it('缺少许可时停在内存状态，不取钥、不登记', async () => {
    const h = await harness()
    const session = h.start({ permit: () => undefined })
    expect(await session.ready()).toMatchObject({ kind: 'memory', reason: 'session-invalid' })
    expect(h.host).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.local.register).not.toHaveBeenCalled()
    session.dispose()
  })

  it('准备开始即捕获许可；取钥期间换人不会重新读取许可 getter', async () => {
    const h = await harness()
    const original = { ...testSessionPermit() }
    const expected = { ...original }
    const getter = vi.fn(() => original)
    const waiting = deferred<LocalKeyHandle | LocalKeyProblem>()
    h.ensure.mockReturnValue(waiting.promise)
    const session = h.start({ permit: getter })
    original.generation = '0199b0c4-7d3e-7a3b-9c4e-000000000002'
    h.local.bind.mockResolvedValue({ kind: 'session-invalid' })
    waiting.resolve(h.key)
    expect(await session.ready()).toMatchObject({ kind: 'memory', reason: 'session-invalid', problem: { kind: 'session-invalid' } })
    expect(getter).toHaveBeenCalledTimes(1)
    expect(h.local.bind).toHaveBeenCalledExactlyOnceWith(expected)
    expect(h.local.setKey).not.toHaveBeenCalled()
    expect(h.local.register).not.toHaveBeenCalled()
    expect(h.local.dispose).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('已明确恢复的新一轮可以拿新许可，但各宿主只绑定各自开始时的一份', async () => {
    const h = await harness()
    let permit = testSessionPermit()
    const old = { ...permit }
    const session = h.start({ permit: () => permit })
    expect((await session.ready()).kind).toBe('ready')
    session.suspend()()
    const next = fakeHost()
    h.host.mockResolvedValue(next.host)
    permit = { ...old, generation: '0199b0c4-7d3e-7a3b-9c4e-000000000002' }
    expect((await session.resume()).kind).toBe('ready')
    expect(h.local.bind).toHaveBeenCalledExactlyOnceWith(old)
    expect(next.bind).toHaveBeenCalledExactlyOnceWith(permit)
    expect(next.bind.mock.invocationCallOrder[0]).toBeLessThan(next.setKey.mock.invocationCallOrder[0] ?? 0)
    session.dispose()
  })

  it('只读重开也沿用原准备的许可，不从新登录借资格', async () => {
    const h = await harness()
    let permit = testSessionPermit()
    const old = { ...permit }
    const session = h.start({ permit: () => permit })
    expect((await session.ready()).kind).toBe('ready')
    h.local.break()
    permit = { ...old, generation: '0199b0c4-7d3e-7a3b-9c4e-000000000002' }
    const next = fakeHost()
    next.bind.mockResolvedValue({ kind: 'session-invalid' })
    h.host.mockResolvedValue(next.host)
    expect(await session.readRecovered()).toEqual({ kind: 'session-invalid' })
    expect(next.bind).toHaveBeenCalledExactlyOnceWith(old)
    expect(next.setKey).not.toHaveBeenCalled()
    expect(next.read).not.toHaveBeenCalled()
    expect(next.dispose).toHaveBeenCalledTimes(1)
    session.dispose()
  })
})
