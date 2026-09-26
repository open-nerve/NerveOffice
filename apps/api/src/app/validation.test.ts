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
})
