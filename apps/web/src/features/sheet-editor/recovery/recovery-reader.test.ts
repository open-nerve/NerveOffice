import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { ObserveResult } from '../../../shared/outbox/draft-writer.ts'
import type { LocalKeyKeeper, LocalKeyProblem } from '../../../shared/outbox/local-key.ts'
import type { OutboxHost } from '../outbox/outbox-host.ts'
import type { RecoveryReaderOptions } from './recovery-reader.ts'
import { describe, expect, it, vi } from 'vitest'
import { DOCUMENT_ID, NOW, sampleMeta, USER_ID } from '../../../shared/outbox/draft-record.test-support.ts'
import { fakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import { createDraftWriter } from '../../../shared/outbox/draft-writer.ts'
import { fakeLeaseClock, settle } from '../fake-lease-clock.test-support.ts'
import { createRecoveryReader } from './recovery-reader.ts'

const KEY = { userId: USER_ID, documentId: DOCUMENT_ID }
const ABSENT: Extract<ObserveResult, { kind: 'observed' }> = { kind: 'observed', observation: { key: KEY, id: 'empty' }, record: { kind: 'absent' }, writer: undefined }
const DRAFT: Extract<ObserveResult, { kind: 'observed' }> = { ...ABSENT, observation: { key: KEY, id: 'draft' }, record: { kind: 'draft', meta: sampleMeta(), gzip: new Uint8Array([1, 2]) } }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function harness(initialKey = false) {
  const key: LocalKeyHandle = { version: 1, key: await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt', 'decrypt']) }
  let current: LocalKeyHandle | undefined = initialKey ? key : undefined
  const listeners = new Set<(key: LocalKeyHandle | undefined) => void>()
  const changeKey = (next: LocalKeyHandle | undefined) => {
    current = next
    for (const listener of listeners)
      listener(next)
  }
  const ensure = vi.fn(async (): Promise<LocalKeyHandle | LocalKeyProblem> => {
    if (current === undefined)
      changeKey(key)
    return current ?? { kind: 'discarded' }
  })
  const keeper: LocalKeyKeeper = {
    current: () => current,
    ensure,
    observeVersion: vi.fn(() => changeKey(undefined)),
    discard: vi.fn(() => changeKey(undefined)),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const writer = createDraftWriter({ store: fakeDraftStore().store, now: () => NOW })
  const observe = vi.spyOn(writer, 'observe').mockResolvedValue(ABSENT)
  const remove = vi.spyOn(writer, 'removeObserved').mockResolvedValue({ kind: 'removed', mirror: { kind: 'removed' } })
  const register = vi.spyOn(writer, 'register')
  const adopt = vi.spyOn(writer, 'adopt')
  const setKey = vi.spyOn(writer, 'setKey').mockResolvedValue({ kind: 'key-set', notResealed: [] })
  const dispose = vi.fn()
  let broken = false
  let alive = true
  const local: OutboxHost = { kind: 'worker', writer, dispose, broken: () => broken }
  const host = vi.fn(async (_signal: AbortSignal) => local)
  const onSessionProblem = vi.fn()
  const options: RecoveryReaderOptions = { key: KEY, keeper, host, clock: fakeLeaseClock().clock, still: () => alive, onSessionProblem }
  return {
    key,
    keeper,
    ensure,
    writer,
    observe,
    remove,
    register,
    adopt,
    setKey,
    dispose,
    local,
    host,
    onSessionProblem,
    options,
    changeKey,
    break: () => { broken = true },
    end: () => { alive = false },
    start: () => createRecoveryReader(options),
  }
}

describe('独立恢复读取器', () => {
  it.each(['absent', 'malformed', 'newer-format'] as const)('%s 无需密钥，也不登记或采用', async (kind) => {
    const h = await harness()
    const record = kind === 'newer-format' ? { kind, recordVersion: 99 } : { kind }
    h.observe.mockResolvedValue({ ...ABSENT, record })
    const reader = h.start()
    expect(await reader.observe()).toMatchObject({ kind: 'observed', record })
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.register).not.toHaveBeenCalled()
    expect(h.adopt).not.toHaveBeenCalled()
    reader.dispose()
  })

  it('有记录才取钥，在同一宿主重读；没有部署开关依赖', async () => {
    const h = await harness()
    h.observe.mockResolvedValueOnce({ ...DRAFT, record: { kind: 'no-key', meta: sampleMeta() } }).mockResolvedValue(DRAFT)
    const reader = h.start()
    expect(await reader.observe()).toMatchObject({ kind: 'observed', record: DRAFT.record })
    expect(h.ensure).toHaveBeenCalledTimes(1)
    expect(h.setKey).toHaveBeenLastCalledWith(h.key)
    expect(h.observe).toHaveBeenCalledTimes(2)
    expect(h.host).toHaveBeenCalledTimes(1)
    reader.dispose()
  })

  it('会话取钥失败保留 no-key 原件并交给页面确认，不自动删除', async () => {
    const h = await harness()
    const error = new Error('会话待确认')
    h.ensure.mockResolvedValue({ kind: 'session', error })
    h.observe.mockResolvedValue({ ...DRAFT, record: { kind: 'no-key', meta: sampleMeta() } })
    const reader = h.start()
    expect(await reader.observe()).toMatchObject({ record: { kind: 'no-key' } })
    expect(h.onSessionProblem).toHaveBeenCalledWith(error)
    expect(h.remove).not.toHaveBeenCalled()
    reader.dispose()
  })

  it.each(['denied', 'set-key', 'throw'] as const)('无钥时已经看见记录，取钥后 %s 仍保留存在事实且不授予旧清理凭证', async (failure) => {
    const h = await harness()
    const first = { ...DRAFT, record: { kind: 'no-key' as const, meta: sampleMeta() } }
    h.observe.mockResolvedValueOnce(first)
    if (failure === 'denied')
      h.observe.mockResolvedValue({ kind: 'unavailable', reason: 'denied' })
    if (failure === 'set-key')
      h.setKey.mockResolvedValue({ kind: 'failed', error: { name: 'InstallFailed', message: 'test' } })
    if (failure === 'throw')
      h.observe.mockRejectedValue(new Error('second read failed'))
    const reader = h.start()
    const result = await reader.observe()
    expect(result).toMatchObject({ kind: failure === 'denied' ? 'unavailable' : 'failed', recordKnown: true })
    expect(result).not.toHaveProperty('observation')
    expect(await reader.remove(first.observation)).toMatchObject({ kind: 'failed' })
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.register).not.toHaveBeenCalled()
    expect(h.adopt).not.toHaveBeenCalled()
    reader.dispose()
  })

  it('无钥后取钥的完整新观察证实原件已消失，交回真实 absent', async () => {
    const h = await harness()
    h.observe.mockResolvedValueOnce({ ...DRAFT, record: { kind: 'no-key', meta: sampleMeta() } }).mockResolvedValue(ABSENT)
    const reader = h.start()
    expect(await reader.observe()).toEqual(ABSENT)
    expect(h.observe).toHaveBeenCalledTimes(2)
    reader.dispose()
  })

  it('刷新旧钥一次后重新观察，旧观察资格立即作废', async () => {
    const h = await harness(true)
    h.observe.mockResolvedValue(DRAFT)
    const reader = h.start()
    const old = await reader.observe()
    if (old.kind !== 'observed')
      throw new Error('缺少观察')
    await reader.refreshKey(2)
    expect(h.keeper.observeVersion).toHaveBeenCalledExactlyOnceWith(2, false)
    expect(h.ensure).toHaveBeenCalledTimes(1)
    expect(await reader.remove(old.observation)).toMatchObject({ kind: 'failed' })
    expect(h.remove).not.toHaveBeenCalled()
    reader.dispose()
  })

  it('只有原对象可清理；暂时失败可以用同一凭证重试，成功后不能重用', async () => {
    const h = await harness(true)
    h.observe.mockResolvedValue(DRAFT)
    const reader = h.start()
    const original = await reader.observe()
    if (original.kind !== 'observed')
      throw new Error('缺少观察')
    expect(Object.isFrozen(original.observation)).toBe(true)
    expect(Object.isFrozen(original.observation.key)).toBe(true)
    expect(await reader.remove({ ...original.observation })).toMatchObject({ kind: 'failed' })
    h.remove.mockResolvedValueOnce({ kind: 'quota' })
    expect(await reader.remove(original.observation)).toEqual({ kind: 'quota' })
    expect(await reader.remove(original.observation)).toMatchObject({ kind: 'removed' })
    expect(await reader.remove(original.observation)).toMatchObject({ kind: 'failed' })
    expect(h.remove).toHaveBeenCalledTimes(2)
    reader.dispose()
  })

  it.each(['broken', 'key', 'ended', 'disposed'] as const)('%s 之后旧凭证不能重建宿主清理', async (cause) => {
    const h = await harness(true)
    h.observe.mockResolvedValue(DRAFT)
    const reader = h.start()
    const original = await reader.observe()
    if (original.kind !== 'observed')
      throw new Error('缺少观察')
    if (cause === 'broken')
      h.break()
    if (cause === 'key')
      h.changeKey(undefined)
    if (cause === 'ended')
      h.end()
    if (cause === 'disposed')
      reader.dispose()
    expect(await reader.remove(original.observation)).toMatchObject({ kind: 'failed' })
    expect(h.host).toHaveBeenCalledTimes(1)
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.dispose).toHaveBeenCalledTimes(1)
    reader.dispose()
  })

  it('新观察使旧观察作废，迟到的旧读取不能覆盖新凭证', async () => {
    const h = await harness(true)
    const delayed = deferred<ObserveResult>()
    h.observe.mockReturnValueOnce(delayed.promise).mockResolvedValue(DRAFT)
    const reader = h.start()
    const first = reader.observe()
    await settle()
    const second = reader.observe()
    delayed.resolve(ABSENT)
    expect(await first).toMatchObject({ kind: 'failed' })
    const latest = await second
    if (latest.kind !== 'observed')
      throw new Error('缺少新观察')
    expect(await reader.remove(latest.observation)).toMatchObject({ kind: 'removed' })
    reader.dispose()
  })

  it('关闭时中止迟到的宿主，只关闭一次且不触碰管道', async () => {
    const h = await harness()
    const delayed = deferred<OutboxHost>()
    h.host.mockReturnValue(delayed.promise)
    const reader = h.start()
    const pending = reader.observe()
    await settle()
    reader.dispose()
    expect(h.host.mock.calls[0]?.[0].aborted).toBe(true)
    delayed.resolve(h.local)
    expect(await pending).toMatchObject({ kind: 'failed' })
    expect(h.dispose).toHaveBeenCalledTimes(1)
    expect(h.observe).not.toHaveBeenCalled()
    expect(h.keeper.discard).toHaveBeenCalledTimes(1)
  })

  it('取钥时换人不安装迟到密钥、不清理', async () => {
    const h = await harness()
    const delayed = deferred<LocalKeyHandle | LocalKeyProblem>()
    h.ensure.mockReturnValue(delayed.promise)
    h.observe.mockResolvedValue({ ...DRAFT, record: { kind: 'no-key', meta: sampleMeta() } })
    const reader = h.start()
    const pending = reader.observe()
    await settle()
    h.end()
    delayed.resolve(h.key)
    expect(await pending).toMatchObject({ kind: 'failed' })
    expect(h.setKey).not.toHaveBeenCalledWith(h.key)
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.dispose).toHaveBeenCalledTimes(1)
  })

  it('提示仅交回当前文档，按原 at 清除；不取钥、不登记', async () => {
    const h = await harness()
    const notice = { ...KEY, kind: 'restored' as const, at: NOW }
    vi.spyOn(h.writer, 'notices').mockResolvedValue({ kind: 'notices', notices: [notice, { ...notice, documentId: 'another-document' }] })
    const clear = vi.spyOn(h.writer, 'clearNotice').mockResolvedValue({ kind: 'changed' })
    const reader = h.start()
    expect(await reader.notices()).toEqual({ kind: 'notices', notices: [notice] })
    expect(await reader.clearNotice(NOW)).toEqual({ kind: 'changed' })
    expect(clear).toHaveBeenCalledExactlyOnceWith(KEY, NOW)
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.register).not.toHaveBeenCalled()
    reader.dispose()
  })
})
