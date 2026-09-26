import { describe, expect, it } from 'vitest'
import { ApiError, NetworkError } from './client.ts'
import { describeError } from './describe-error.ts'

describe('describeError', () => {
  it('登记过的错误码：用前端的文字，带请求标识', () => {
    expect(describeError(new ApiError(401, 'INVALID_CREDENTIALS', '服务端的说明', { requestId: 'r1' }))).toEqual({ message: '用户名或密码错误', requestId: 'r1' })
  })

  it('尝试次数过多：按 Retry-After 换算成分钟（向上取整）', () => {
    expect(describeError(new ApiError(429, 'TOO_MANY_ATTEMPTS', 'x', { retryAfterSeconds: 61 })).message).toBe('尝试次数过多，请 2 分钟后再试')
    expect(describeError(new ApiError(429, 'TOO_MANY_ATTEMPTS', 'x')).message).toBe('尝试次数过多，请稍后再试')
  })

  it('前端还不认识的错误码：用服务端的说明；不是约定的格式：通用说明', () => {
    expect(describeError(new ApiError(409, 'DOCUMENT_LOCKED', '文档正被别人编辑')).message).toBe('文档正被别人编辑')
    expect(describeError(new ApiError(502, 'UNKNOWN', 'x')).message).toBe('出了点问题，请稍后重试')
  })

  it('网络失败与其他异常', () => {
    expect(describeError(new NetworkError('x')).message).toBe('网络连接失败，请检查网络后重试')
    expect(describeError(new Error('x')).message).toBe('出了点问题，请稍后重试')
  })
})
