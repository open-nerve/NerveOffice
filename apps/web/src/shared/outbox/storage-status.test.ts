import { describe, expect, it, vi } from 'vitest'
import { browserStorageManager, requestPersistence, storageEstimate, storagePersisted } from './storage-status.ts'

/** 假的 StorageManager：只给用例要的那几个方法 */
function fakeManager(methods: Partial<Record<'persisted' | 'persist' | 'estimate', () => Promise<unknown>>>): StorageManager {
  return methods as unknown as StorageManager
}

describe('本机存储的状态（M4-P1 设计 §3.1、§3.5）：包住 navigator.storage，结果一律带 kind、不抛异常', () => {
  it('是否已获准持久保存：true 是 persisted，false 是 not-persisted', async () => {
    await expect(storagePersisted(fakeManager({ persisted: async () => true }))).resolves.toEqual({ kind: 'persisted' })
    await expect(storagePersisted(fakeManager({ persisted: async () => false }))).resolves.toEqual({ kind: 'not-persisted' })
  })

  it('申请持久保存：true 是 granted，false 是 denied（浏览器不给）', async () => {
    const persist = vi.fn(async () => true)
    await expect(requestPersistence(fakeManager({ persist }))).resolves.toEqual({ kind: 'granted' })
    expect(persist).toHaveBeenCalledTimes(1)
    await expect(requestPersistence(fakeManager({ persist: async () => false }))).resolves.toEqual({ kind: 'denied' })
  })

  it('用量与配额：交回两个数；浏览器没给的、不是有限的非负数的为 undefined', async () => {
    await expect(storageEstimate(fakeManager({ estimate: async () => ({ usage: 1_234, quota: 5_000_000 }) }))).resolves.toEqual({ kind: 'estimated', usage: 1_234, quota: 5_000_000 })
    await expect(storageEstimate(fakeManager({ estimate: async () => ({ quota: 10 }) }))).resolves.toEqual({ kind: 'estimated', usage: undefined, quota: 10 })
    await expect(storageEstimate(fakeManager({ estimate: async () => ({ usage: -1, quota: Number.NaN }) }))).resolves.toEqual({ kind: 'estimated', usage: undefined, quota: undefined })
    await expect(storageEstimate(fakeManager({ estimate: async () => null }))).resolves.toEqual({ kind: 'estimated', usage: undefined, quota: undefined })
  })

  it('没有接口：没有 StorageManager、或者没有那个方法，都是 unsupported', async () => {
    for (const manager of [undefined, fakeManager({})]) {
      await expect(storagePersisted(manager)).resolves.toEqual({ kind: 'unsupported' })
      await expect(requestPersistence(manager)).resolves.toEqual({ kind: 'unsupported' })
      await expect(storageEstimate(manager)).resolves.toEqual({ kind: 'unsupported' })
    }
  })

  it('出错（拒绝的 Promise、同步抛出）：failed，只带名字与消息', async () => {
    const rejecting = async (): Promise<never> => {
      throw new DOMException('私密模式里不给', 'InvalidStateError')
    }
    // 同步抛出（不是返回拒绝的 Promise）
    const throwing = (): never => {
      throw new TypeError('坏了')
    }
    await expect(storagePersisted(fakeManager({ persisted: rejecting }))).resolves.toEqual({ kind: 'failed', error: { name: 'InvalidStateError', message: '私密模式里不给' } })
    await expect(requestPersistence(fakeManager({ persist: rejecting }))).resolves.toEqual({ kind: 'failed', error: { name: 'InvalidStateError', message: '私密模式里不给' } })
    await expect(storageEstimate(fakeManager({ estimate: throwing }))).resolves.toEqual({ kind: 'failed', error: { name: 'TypeError', message: '坏了' } })
    await expect(storagePersisted(fakeManager({ persisted: async () => Promise.reject(new Error('x')) }))).resolves.toMatchObject({ kind: 'failed' })
  })

  it('页面里取 navigator.storage；取它本身抛出（沙箱的限制）时当作没有', () => {
    vi.stubGlobal('navigator', { storage: fakeManager({}) })
    expect(browserStorageManager()).toEqual({})
    vi.stubGlobal('navigator', Object.defineProperty({}, 'storage', { get: () => {
      throw new DOMException('不给', 'SecurityError')
    } }))
    expect(browserStorageManager()).toBeUndefined()
    vi.stubGlobal('navigator', {})
    expect(browserStorageManager()).toBeUndefined()
  })
})
