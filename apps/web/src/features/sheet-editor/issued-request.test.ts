import type { MarkerStorage } from './pending-save-marker.ts'
import { describe, expect, it } from 'vitest'
import { issuedHere, issuedRequestKeyOf, issuedRequestMarker } from './issued-request.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const OTHER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
const AT = '2026-10-07T03:01:00.000Z'

/** 内存里的存储（sessionStorage 的子集） */
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

describe('这一页发出过的请求编辑的记号（M3-P5 审查 B2）', () => {
  it('写下之后读得到（发出的时刻，或者不带时刻），键是 nerve-office:edit-request:<documentId>；清掉之后没有；每份文档各自一个', () => {
    const storage = memoryStorage()
    const marker = issuedRequestMarker(DOCUMENT_ID, { storage: () => storage })
    expect(marker.read()).toBeUndefined()
    marker.write(AT)
    expect(issuedRequestKeyOf(DOCUMENT_ID)).toBe(`nerve-office:edit-request:${DOCUMENT_ID}`)
    expect(JSON.parse(storage.items.get(issuedRequestKeyOf(DOCUMENT_ID)) ?? 'null')).toEqual({ v: 1, requestedAt: AT })
    expect(marker.read()).toEqual({ requestedAt: AT })
    expect(issuedRequestMarker(OTHER_ID, { storage: () => storage }).read()).toBeUndefined()
    marker.write(undefined)
    expect(JSON.parse(storage.items.get(issuedRequestKeyOf(DOCUMENT_ID)) ?? 'null')).toEqual({ v: 1 })
    expect(marker.read()).toEqual({ requestedAt: undefined })
    marker.clear()
    expect(marker.read()).toBeUndefined()
    expect(storage.items.size).toBe(0)
  })

  it.each([
    ['不是 JSON', '{'],
    ['别的版本写的', JSON.stringify({ v: 2, requestedAt: AT })],
    ['字段不对', JSON.stringify({ v: 1, requestedAt: 7 })],
  ])('读出来认不出（%s）：当作没有（不是这一页发出的）', (_case, raw) => {
    const storage = memoryStorage()
    storage.items.set(issuedRequestKeyOf(DOCUMENT_ID), raw)
    expect(issuedRequestMarker(DOCUMENT_ID, { storage: () => storage }).read()).toBeUndefined()
  })

  it('存储不可用：取它就抛出（被禁用、沙箱）、读写抛出——读出来是没有，写与清什么也不做，不抛出', () => {
    const unavailable = issuedRequestMarker(DOCUMENT_ID, {
      storage: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    expect(() => unavailable.write(AT)).not.toThrow()
    expect(unavailable.read()).toBeUndefined()
    expect(() => unavailable.clear()).not.toThrow()
    const failing: MarkerStorage = {
      getItem: () => {
        throw new Error('读不了')
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('删不了')
      },
    }
    const broken = issuedRequestMarker(DOCUMENT_ID, { storage: () => failing })
    expect(() => broken.write(AT)).not.toThrow()
    expect(broken.read()).toBeUndefined()
    expect(() => broken.clear()).not.toThrow()
  })

  it('认（issuedHere）：本人待回应的请求要发出时刻对得上；留给本人的保留有记号就算；没有记号、没有本人的请求都不是', () => {
    expect(issuedHere(undefined, { requestedAt: AT, reserved: false })).toBe(false)
    expect(issuedHere(undefined, { requestedAt: undefined, reserved: true })).toBe(false)
    expect(issuedHere({ requestedAt: AT }, { requestedAt: AT, reserved: false })).toBe(true)
    expect(issuedHere({ requestedAt: AT }, { requestedAt: '2026-10-07T03:02:00.000Z', reserved: false })).toBe(false)
    expect(issuedHere({ requestedAt: undefined }, { requestedAt: AT, reserved: false })).toBe(false)
    expect(issuedHere({ requestedAt: AT }, { requestedAt: undefined, reserved: true })).toBe(true)
    expect(issuedHere({ requestedAt: undefined }, { requestedAt: undefined, reserved: true })).toBe(true)
    expect(issuedHere({ requestedAt: AT }, { requestedAt: undefined, reserved: false })).toBe(false)
  })
})
