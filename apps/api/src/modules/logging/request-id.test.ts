import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { requestIdOf, resolveRequestId } from './request-id.ts'

const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

describe('resolveRequestId', () => {
  it.each(['abc', 'req-1', 'a.b:c_d', 'x'.repeat(128), '550e8400-e29b-41d4-a716-446655440000'])('接受合法的请求标识 %s', (value) => {
    expect(resolveRequestId(value, () => 'generated')).toBe(value)
  })

  it.each(['', 'has space', 'x'.repeat(129), 'a\nb', 'a\r\nX-Injected: 1', '中文', '<script>'])('拒绝 %j，改为新生成的', (value) => {
    expect(resolveRequestId(value, () => 'generated')).toBe('generated')
  })

  it('没有或出现多个同名请求头时生成新的', () => {
    expect(resolveRequestId(undefined, () => 'generated')).toBe('generated')
    expect(resolveRequestId(['a', 'b'], () => 'generated')).toBe('generated')
  })

  it('默认生成 UUID', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID)
  })
})

describe('requestIdOf', () => {
  it('取请求日志中间件生成的请求标识；没有时说明原因', () => {
    expect(requestIdOf({ id: 'req-1' } as unknown as IncomingMessage)).toBe('req-1')
    expect(() => requestIdOf({} as IncomingMessage)).toThrow('请求日志中间件')
  })
})
