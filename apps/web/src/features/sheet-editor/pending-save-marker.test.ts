import type { MarkerStorage } from './pending-save-marker.ts'
import { describe, expect, it } from 'vitest'
import { keyOf, pendingSaveMarker } from './pending-save-marker.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const OTHER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-000000000001'
const OTHER_USER = '0199a2c4-1f2e-7a3b-8c4d-000000000002'
const AT = Date.UTC(2026, 9, 7, 3, 0, 0)

/** 内存里的存储（localStorage 的子集） */
function memoryStorage(): MarkerStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

describe('刷新时在途的保存的记号（M3-P5 设计 §3.7 的 R1）', () => {
  it('写下之后读得到（墙上时间、基准修订号），键是 nerve-office:pending-save:<userId>:<documentId>；清掉之后没有；每份文档各自一个', () => {
    const storage = memoryStorage()
    let now = AT
    const marker = pendingSaveMarker(USER_ID, DOCUMENT_ID, { storage: () => storage, now: () => now })
    expect(marker.read()).toBeUndefined()
    marker.write(7)
    expect(keyOf(USER_ID, DOCUMENT_ID)).toBe(`nerve-office:pending-save:${USER_ID}:${DOCUMENT_ID}`)
    expect(JSON.parse(storage.items.get(keyOf(USER_ID, DOCUMENT_ID)) ?? 'null')).toEqual({ v: 1, at: AT, revision: 7 })
    expect(marker.read()).toEqual({ at: AT, revision: 7 })
    expect(pendingSaveMarker(USER_ID, OTHER_ID, { storage: () => storage, now: () => now }).read()).toBeUndefined()
    // 再写一次覆盖（新的时刻）
    now += 5_000
    marker.write(8)
    expect(marker.read()).toEqual({ at: AT + 5_000, revision: 8 })
    marker.clear()
    expect(marker.read()).toBeUndefined()
    expect(storage.items.size).toBe(0)
  })

  it('同文档的另一账户不继承或误删；旧未分用户记号不读取、不迁移', () => {
    const storage = memoryStorage()
    const old = `nerve-office:pending-save:${DOCUMENT_ID}`
    storage.items.set(old, JSON.stringify({ v: 1, at: AT, revision: 99 }))
    const first = pendingSaveMarker(USER_ID, DOCUMENT_ID, { storage: () => storage, now: () => AT })
    const second = pendingSaveMarker(OTHER_USER, DOCUMENT_ID, { storage: () => storage, now: () => AT })
    expect(first.read()).toBeUndefined()
    expect(second.read()).toBeUndefined()
    first.write(3)
    expect(second.read()).toBeUndefined()
    second.write(7)
    first.clear()
    expect(first.read()).toBeUndefined()
    expect(second.read()).toEqual({ at: AT, revision: 7 })
    expect(storage.items.has(old)).toBe(true)
  })

  it.each([
    ['不是 JSON', '{'],
    ['别的版本写的', JSON.stringify({ v: 2, at: AT, revision: 7 })],
    ['缺了字段', JSON.stringify({ v: 1, at: AT })],
    ['字段不对', JSON.stringify({ v: 1, at: 'yesterday', revision: 7 })],
    ['修订号不合法', JSON.stringify({ v: 1, at: AT, revision: 0 })],
  ])('读出来认不出（%s）：当作没有', (_case, raw) => {
    const storage = memoryStorage()
    storage.items.set(keyOf(USER_ID, DOCUMENT_ID), raw)
    expect(pendingSaveMarker(USER_ID, DOCUMENT_ID, { storage: () => storage, now: () => AT }).read()).toBeUndefined()
  })

  it('存储不可用：取它就抛出（被禁用、沙箱）、写满了（配额）、读写抛出——一律什么也不做，不抛出', () => {
    const unavailable = pendingSaveMarker(USER_ID, DOCUMENT_ID, {
      storage: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
      now: () => AT,
    })
    expect(() => unavailable.write(7)).not.toThrow()
    expect(unavailable.read()).toBeUndefined()
    expect(() => unavailable.clear()).not.toThrow()

    const failing: MarkerStorage = {
      getItem: () => {
        throw new Error('读不出')
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('删不掉')
      },
    }
    const broken = pendingSaveMarker(USER_ID, DOCUMENT_ID, { storage: () => failing, now: () => AT })
    expect(() => broken.write(7)).not.toThrow()
    expect(broken.read()).toBeUndefined()
    expect(() => broken.clear()).not.toThrow()
  })
})
