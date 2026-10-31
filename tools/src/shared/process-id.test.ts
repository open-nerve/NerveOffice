import { describe, expect, it } from 'vitest'
import { assertSignalPid } from './process-id.ts'

describe('信号目标的数字 PID 范围', () => {
  it.each([0, -0, 1, -1, -42, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2147483648, 4294967298, Number.MAX_SAFE_INTEGER])('拒绝可能改变信号目标语义的数字 %s', (pid) => {
    expect(() => assertSignalPid(pid)).toThrow(RangeError)
  })

  it.each([2, 4242, 2147483647])('接受范围内整数 %s，不查询或授权进程归属', (pid) => {
    expect(() => assertSignalPid(pid)).not.toThrow()
  })
})
