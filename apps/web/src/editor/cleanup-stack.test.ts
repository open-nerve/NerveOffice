import { describe, expect, it, vi } from 'vitest'
import { createCleanupStack } from './cleanup-stack.ts'

describe('资源的清理（审查 B8）', () => {
  it('按登记的相反顺序清理；清理过的不再清理', () => {
    const order: string[] = []
    const cleanup = createCleanupStack()
    cleanup.defer(() => order.push('worker'))
    cleanup.defer(() => order.push('univer'))
    cleanup.defer(() => order.push('watch'))
    cleanup.run()
    cleanup.run()
    expect(order).toEqual(['watch', 'univer', 'worker'])
  })

  it('一项出错：其余照样清理，错误上报', () => {
    const report = vi.fn()
    const order: string[] = []
    const failure = new Error('销毁出错')
    const cleanup = createCleanupStack(report)
    cleanup.defer(() => order.push('worker'))
    cleanup.defer(() => {
      throw failure
    })
    cleanup.defer(() => order.push('watch'))
    cleanup.run()
    expect(order).toEqual(['watch', 'worker'])
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it('清理之后再登记的，下一次清理', () => {
    const order: string[] = []
    const cleanup = createCleanupStack()
    cleanup.defer(() => order.push('a'))
    cleanup.run()
    cleanup.defer(() => order.push('b'))
    cleanup.run()
    expect(order).toEqual(['a', 'b'])
  })

  it('默认交给浏览器的错误报告', () => {
    const failure = new Error('销毁出错')
    const report = vi.fn()
    vi.stubGlobal('reportError', report)
    const cleanup = createCleanupStack()
    cleanup.defer(() => {
      throw failure
    })
    cleanup.run()
    vi.unstubAllGlobals()
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
  })
})
