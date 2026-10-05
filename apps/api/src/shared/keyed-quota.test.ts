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

  it('交回的函数多次调用只交回一次；都交回之后不留这个键', () => {
    const quota = new KeyedQuota(1)
    const release = quota.tryAcquire('amy')
    const other = quota.tryAcquire('ben')
    release?.()
    release?.()
    expect(quota.heldBy('amy')).toBe(0)
    expect(quota.heldBy('ben')).toBe(1)
    other?.()
    expect(quota.heldBy('ben')).toBe(0)
  })

  it('上限必须是正整数', () => {
    expect(() => new KeyedQuota(0)).toThrow(RangeError)
    expect(() => new KeyedQuota(1.5)).toThrow(RangeError)
  })
})
