import { describe, expect, it } from 'vitest'
import { KeyedQuota } from './keyed-quota.ts'

describe('KeyedQuota', () => {
  it('一个键至多 limit 份：占满之后这个键再来的被拒，别的键照常；交回一份之后又能占', () => {
    const quota = new KeyedQuota(2)
    const first = quota.tryAcquire('amy')
    const second = quota.tryAcquire('amy')
    expect([first, second].every(release => release !== undefined)).toBe(true)
    expect(quota.tryAcquire('amy')).toBeUndefined()
    expect(quota.heldBy('amy')).toBe(2)
    expect(quota.tryAcquire('ben')).toBeDefined()
    expect(quota.heldBy('ben')).toBe(1)
    first?.()
    expect(quota.heldBy('amy')).toBe(1)
    expect(quota.tryAcquire('amy')).toBeDefined()
    expect(quota.tryAcquire('amy')).toBeUndefined()
  })

  it('交回的函数多次调用只交回一次：同一个键占着两份，其中一份交回两次，另一份照样占着、照样算在上限里；都交回之后不留这个键', () => {
    const quota = new KeyedQuota(2)
    const first = quota.tryAcquire('amy')
    const second = quota.tryAcquire('amy')
    const other = quota.tryAcquire('ben')
    first?.()
    first?.()
    expect(quota.heldBy('amy')).toBe(1)
    expect(quota.heldBy('ben')).toBe(1)
    // 还占着的那一份照样算：再占一份就满了
    const third = quota.tryAcquire('amy')
    expect(third).toBeDefined()
    expect(quota.tryAcquire('amy')).toBeUndefined()
    second?.()
    third?.()
    third?.()
    expect(quota.heldBy('amy')).toBe(0)
    other?.()
    expect(quota.heldBy('ben')).toBe(0)
  })

  it('上限必须是正整数', () => {
    expect(() => new KeyedQuota(0)).toThrow(RangeError)
    expect(() => new KeyedQuota(1.5)).toThrow(RangeError)
  })
})
