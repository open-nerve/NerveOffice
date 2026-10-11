/* eslint-disable ts/promise-function-async -- 原生边界替身和断言必须验证同一个 Promise 与同步抛错。 */
import type { LockApi } from '../../same-browser.ts'
import type { reloadIdentitySelector as Factory } from '../reload-identity.ts'
import type { ReloadStorage } from '../reload-marker.ts'
import { describe, expect, it } from 'vitest'
import { reloadIdentitySelector } from '../reload-identity.ts'
import { observeReloadIdentity } from './reload-diagnostics.ts'

const USER = '3f1f40c3-1579-4657-9902-9f1f804fdde1'
const DOCUMENT = '2f1f40c3-1579-4657-9902-9f1f804fdde1'
const CLIENT = '6f1f40c3-1579-4657-9902-9f1f804fdde1'
const FRESH = '7f1f40c3-1579-4657-9902-9f1f804fdde1'
const WRITER = '4f1f40c3-1579-4657-9902-9f1f804fdde1'
const key = { userId: USER, documentId: DOCUMENT }
const marker = { ...key, clientInstanceId: CLIENT, writeEpoch: 2, writerId: WRITER }
const storageKey = `nerve-office:reload:${USER}:${DOCUMENT}`
const navigation = () => ({ timeOrigin: 100, type: 'navigate' as const, discarded: 'unsupported' as const, key: CLIENT, id: WRITER, activation: null, fromKey: null, fromId: null })

function storage() {
  const values = new Map([[storageKey, JSON.stringify({ v: 1, ...marker })]])
  const target: ReloadStorage = {
    get length() { return values.size },
    key: index => [...values.keys()][index] ?? null,
    getItem: name => values.get(name) ?? null,
    setItem: () => { throw new Error('本组测试没有写入授权') },
    removeItem: (name) => { values.delete(name) },
  }
  return { target, values }
}

function locks() {
  const held = new Set<string>()
  const api: LockApi = {
    request: async (name, _options, callback) => {
      if (held.has(name))
        return callback(null)
      held.add(name)
      try {
        await callback({ name })
      }
      finally {
        held.delete(name)
      }
    },
    query: async () => ({ held: [...held].map(name => ({ name })) }),
  }
  return { api, held }
}

describe('reload 诊断只读地包住原选择器', () => {
  it('捕获同步清理前的合法记号，普通导航仍由生产选择器清空', async () => {
    const s = storage()
    const observed = observeReloadIdentity(reloadIdentitySelector, navigation)
    const select = observed.selector({ navigation: { type: 'navigate', wasDiscarded: false }, storage: () => s.target, locks: undefined })
    expect(s.values.size).toBe(0)
    const identity = await select({ key, freshId: FRESH, matches: async () => true, still: () => true })
    expect(identity.clientInstanceId).toBe(FRESH)
    expect(observed.snapshot()).toMatchObject({ initial: { navigation: { key: CLIENT }, storage: { status: 'available', markers: [marker] } }, current: { storage: { markers: [] } }, events: [{ kind: 'selected', clientInstanceId: FRESH, candidate: false }] })
  })

  it('原页资格、持锁生命周期和匹配结果仍由真实选择器控制', async () => {
    const s = storage()
    const l = locks()
    const observed = observeReloadIdentity(reloadIdentitySelector, navigation)
    const select = observed.selector({ navigation: { type: 'reload', wasDiscarded: false }, storage: () => s.target, locks: l.api })
    const identity = await select({ key, freshId: FRESH, matches: async () => true, still: () => true })
    expect(identity.candidate).toEqual(marker)
    expect(l.held.size).toBe(1)
    expect(observed.snapshot().events).toEqual([{ kind: 'lock', clientInstanceId: CLIENT, result: 'held' }, { kind: 'match', clientInstanceId: CLIENT, result: 'match' }, { kind: 'selected', clientInstanceId: CLIENT, candidate: true }])
    identity.dispose()
    await expect.poll(() => l.held.size).toBe(0)
    expect(s.values.size).toBe(1)
  })

  it('原件读取异常不被诊断吞掉，生产选择器仍丢弃旧候选并持有新实例', async () => {
    const s = storage()
    const l = locks()
    const observed = observeReloadIdentity(reloadIdentitySelector, navigation)
    const select = observed.selector({ navigation: { type: 'reload', wasDiscarded: false }, storage: () => s.target, locks: l.api })
    const identity = await select({
      key,
      freshId: FRESH,
      still: () => true,
      matches: async () => {
        throw new Error('敏感原错误不应进入报告')
      },
    })
    expect(identity.clientInstanceId).toBe(FRESH)
    expect(observed.snapshot().events).toContainEqual({ kind: 'match', clientInstanceId: CLIENT, result: 'error' })
    expect(JSON.stringify(observed.snapshot())).not.toContain('敏感')
    expect(s.values.size).toBe(0)
    identity.dispose()
  })

  it('不收录原始坏值或额外字段，读取不可用时也不改变选择器流程', () => {
    const s = storage()
    s.values.set(storageKey, JSON.stringify({ v: 1, ...marker, secret: 'never-export' }))
    const observed = observeReloadIdentity(reloadIdentitySelector, navigation)
    observed.selector({ navigation: { type: 'reload', wasDiscarded: false }, storage: () => s.target, locks: undefined })
    expect(observed.snapshot().initial.storage).toEqual({ status: 'available', markers: [], invalid: 1, truncated: false })
    expect(JSON.stringify(observed.snapshot())).not.toContain('never-export')
    expect(s.values.size).toBe(1)
    const unavailable = observeReloadIdentity(reloadIdentitySelector, () => {
      throw new Error('navigation denied')
    })
    const blockedStorage = (): ReloadStorage => {
      throw new Error('storage denied')
    }
    expect(() => unavailable.selector({ navigation: { type: 'navigate', wasDiscarded: false }, storage: blockedStorage, locks: undefined })).not.toThrow()
    expect(unavailable.snapshot().initial).toEqual({ navigation: null, storage: { status: 'unavailable', markers: [], invalid: 0, truncated: false } })
  })

  it('保持原生锁 receiver、选项、回调 Promise、返回 Promise 与异常对象', async () => {
    const error = new Error('do not serialize')
    const callbackPromise = Promise.resolve()
    const returned = Promise.resolve('same result')
    const options = { mode: 'exclusive' as const, ifAvailable: true }
    let wrapped: LockApi | undefined
    const factory: typeof Factory = (input) => {
      wrapped = input.locks
      return async () => {
        throw new Error('unused selector')
      }
    }
    const original: LockApi = {
      request(name, received, callback) {
        expect(this).toBe(original)
        expect(received).toBe(options)
        if (name.endsWith(FRESH))
          throw error
        expect(callback({ name })).toBe(callbackPromise)
        return returned
      },
      query: async () => ({ held: [] }),
    }
    const observed = observeReloadIdentity(factory, navigation)
    observed.selector({ navigation: { type: 'reload', wasDiscarded: false }, storage: () => storage().target, locks: original })
    expect(wrapped!.request(`nerve-office:instance:${USER}:${DOCUMENT}:${CLIENT}`, options, () => callbackPromise)).toBe(returned)
    expect(() => wrapped!.request(`nerve-office:instance:${USER}:${DOCUMENT}:${FRESH}`, options, () => callbackPromise)).toThrow(error)
    expect(observed.snapshot().events).toEqual([{ kind: 'lock', clientInstanceId: CLIENT, result: 'held' }, { kind: 'lock', clientInstanceId: FRESH, result: 'error' }])
    await returned
  })

  it('单条存储读取被拒绝报告为不可读，不能误记成坏记号', () => {
    const s = storage()
    const observed = observeReloadIdentity(reloadIdentitySelector, navigation)
    observed.selector({ navigation: { type: 'reload', wasDiscarded: false }, storage: () => ({ ...s.target, getItem: () => {
      throw new Error('denied')
    } }), locks: undefined })
    expect(observed.snapshot().initial.storage).toEqual({ status: 'unavailable', markers: [], invalid: 0, truncated: false })
  })
})
