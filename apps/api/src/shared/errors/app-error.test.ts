import { describe, expect, it } from 'vitest'
import { AppError } from './app-error.ts'

describe('AppError', () => {
  it('HTTP 状态取自登记表；不写说明时用默认说明', () => {
    const error = new AppError('NOT_FOUND')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AppError')
    expect(error.code).toBe('NOT_FOUND')
    expect(error.status).toBe(404)
    expect(error.message).toBe('请求的资源不存在或无权访问')
  })

  it('可以写更具体的说明，并保留原因', () => {
    const cause = new Error('底层原因')
    const error = new AppError('SERVICE_UNAVAILABLE', '正在退出', { cause })
    expect(error.status).toBe(503)
    expect(error.message).toBe('正在退出')
    expect(error.cause).toBe(cause)
  })
})
