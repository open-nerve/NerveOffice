import { describe, expect, it } from 'vitest'
import { validationError } from './validation.ts'

describe('validationError', () => {
  it('列出不合法的字段路径（去重），不回显取值', () => {
    const error = validationError([
      { path: ['title'] },
      { path: [{ key: 'items' }, 0, 'name'] },
      { path: ['title'] },
      {},
    ])
    expect(error.code).toBe('REQUEST_INVALID')
    expect(error.message).toBe('请求参数不合法：title、items.0.name、（整体）')
  })

  it('最多列出 5 处，每处有长度上限：客户端给的键名撑不大响应', () => {
    const issues = Array.from({ length: 8 }, (_, index) => ({ path: [`k${index}`] }))
    expect(validationError(issues).message).toBe('请求参数不合法：k0、k1、k2、k3、k4 等 8 处')
    const long = validationError([{ path: ['x'.repeat(200)] }]).message
    expect(long).toBe(`请求参数不合法：${'x'.repeat(64)}…`)
  })
})
