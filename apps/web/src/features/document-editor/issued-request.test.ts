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
  it('新 Document 不继承合法旧请求记号，原页消失也不能据此续期或接手', () => {
    const storage = memoryStorage()
    storage.items.set(issuedRequestKeyOf(DOCUMENT_ID), JSON.stringify({ v: 1, requestedAt: AT }))
    const page = issuedRequestMarker(DOCUMENT_ID, { storage: () => storage })
    expect(page.read()).toBeUndefined()
    expect(storage.items.has(issuedRequestKeyOf(DOCUMENT_ID))).toBe(false)
    page.write(AT)
    expect(page.read()).toEqual({ requestedAt: AT })
    expect(issuedRequestMarker(DOCUMENT_ID, { storage: () => storage }).read()).toBeUndefined()
  })
  it('本页写下后读得到，清掉后没有；不同页面/文档各自独立，存储中不留下记号', () => {
    const storage = memoryStorage()
    const marker = issuedRequestMarker(DOCUMENT_ID, { storage: () => storage })
    expect(marker.read()).toBeUndefined()
    marker.write(AT)
    expect(issuedRequestKeyOf(DOCUMENT_ID)).toBe(`nerve-office:edit-request:${DOCUMENT_ID}`)
    expect(storage.items.size).toBe(0)
    expect(marker.read()).toEqual({ requestedAt: AT })
    expect(issuedRequestMarker(OTHER_ID, { storage: () => storage }).read()).toBeUndefined()
    marker.write(undefined)
    expect(storage.items.size).toBe(0)
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

  it('存储不可用或清理失败不影响本页明确操作，新的对象仍不继承', () => {
    const unavailable = issuedRequestMarker(DOCUMENT_ID, {
      storage: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    expect(() => unavailable.write(AT)).not.toThrow()
    expect(unavailable.read()).toEqual({ requestedAt: AT })
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
    expect(broken.read()).toEqual({ requestedAt: AT })
    expect(() => broken.clear()).not.toThrow()
    expect(broken.read()).toBeUndefined()
    expect(issuedRequestMarker(DOCUMENT_ID, { storage: () => failing }).read()).toBeUndefined()
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
