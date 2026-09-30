import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { clientRequestIdOf, generateRequestId, requestIdOf } from './request-id.ts'

const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

describe('generateRequestId', () => {
  it('服务端自己的请求标识：每次新生成的 UUID', () => {
    const first = generateRequestId()
    expect(first).toMatch(UUID)
    expect(generateRequestId()).not.toBe(first)
  })
})

describe('clientRequestIdOf（M2-P6 复核 C2：客户端带来的只进日志）', () => {
  it.each(['abc', 'req-1', 'a.b:c_d', 'x'.repeat(128), '550e8400-e29b-41d4-a716-446655440000'])('合法的原样给出：%s', (value) => {
    expect(clientRequestIdOf(value)).toBe(value)
  })

  it.each(['', 'has space', 'x'.repeat(129), 'a\nb', 'a\r\nX-Injected: 1', '中文', '<script>'])('不合法的不记：%j', (value) => {
    expect(clientRequestIdOf(value)).toBeUndefined()
  })

  it('没有或出现多个同名请求头时不记', () => {
    expect(clientRequestIdOf(undefined)).toBeUndefined()
    expect(clientRequestIdOf(['a', 'b'])).toBeUndefined()
  })
})

describe('requestIdOf', () => {
  it('取请求日志中间件生成的请求标识；没有时说明原因', () => {
    expect(requestIdOf({ id: 'req-1' } as unknown as IncomingMessage)).toBe('req-1')
    expect(() => requestIdOf({} as IncomingMessage)).toThrow('请求日志中间件')
  })
})
