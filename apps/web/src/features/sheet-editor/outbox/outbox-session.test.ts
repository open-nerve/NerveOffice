import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { InFlightSave } from '../../../shared/outbox/draft-record.ts'
import type { KeyChange, OpenedRecord, RegisterResult } from '../../../shared/outbox/draft-writer.ts'
import type { LocalKeyKeeper, LocalKeyProblem } from '../../../shared/outbox/local-key.ts'
import type { PersistOutcome } from '../../../shared/outbox/storage-status.ts'
import type { LeaseVerdict } from '../edit-lease.ts'
import type { OutboxHost } from './outbox-host.ts'
import type { OutboxSession, OutboxSessionOptions } from './outbox-session.ts'
import { describe, expect, it, vi } from 'vitest'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, sampleMeta, USER_ID, WRITER_ID } from '../../../shared/outbox/draft-record.test-support.ts'
import { fakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import { createDraftWriter } from '../../../shared/outbox/draft-writer.ts'
import { settle } from '../fake-lease-clock.test-support.ts'
import { prepareOutboxSession } from './outbox-session.ts'

const DRAFT = { userId: USER_ID, documentId: DOCUMENT_ID }
const REGISTERED: RegisterResult = { kind: 'registered', lastDraftSeq: 37, existing: undefined, mirror: { kind: 'off' } }
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
  const register = vi.spyOn(writer, 'register').mockResolvedValue(REGISTERED)
  const setKey = vi.spyOn(writer, 'setKey').mockResolvedValue(KEY_SET)
  const write = vi.spyOn(writer, 'write').mockResolvedValue({ kind: 'written', digest: 'digest', gzip: new Uint8Array([1]), mirror: { kind: 'off' } })
  const markInFlight = vi.spyOn(writer, 'markInFlight').mockResolvedValue({ kind: 'resealed' })
  const confirm = vi.spyOn(writer, 'confirm').mockResolvedValue({ kind: 'deleted' })
  const read = vi.spyOn(writer, 'read').mockResolvedValue({ kind: 'absent' })
  const seedDigest = vi.spyOn(writer, 'seedDigest').mockResolvedValue(undefined)
  const remove = vi.spyOn(writer, 'remove')
  const dispose = vi.spyOn(writer, 'dispose')
  let broken = false
  const host: OutboxHost = { kind: 'worker', writer, broken: () => broken, dispose: () => writer.dispose() }
  return { host, register, setKey, write, markInFlight, confirm, read, seedDigest, remove, dispose, break: () => {
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
  const options: OutboxSessionOptions = { enabled: true, key: DRAFT, writeEpoch: 3, newWriterId, keeper, confirm, host, persist, supported: () => true, still: () => alive }
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
    expect(await session.ready()).toEqual({ kind: 'memory', reason: 'existing-draft', existing: summary, lastDraftSeq: 37 })
    expect(session.view()).toEqual({ kind: 'memory', reason: 'existing-draft', existing: summary, lastDraftSeq: 37 })
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
      register.resolve(REGISTERED)
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
