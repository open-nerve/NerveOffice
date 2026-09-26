import { describe, expect, it } from 'vitest'
import { errorResponseSchema } from './error-response.ts'

const valid = { error: { code: 'DOCUMENT_NOT_FOUND', message: '文档不存在或无权访问', requestId: 'req-1' } }

describe('errorResponseSchema', () => {
  it('接受规范 §4 的错误响应', () => {
    expect(errorResponseSchema.parse(valid)).toEqual(valid)
  })

  it.each([
    ['缺少 code', { error: { message: 'x', requestId: 'r' } }],
    ['缺少 message', { error: { code: 'X', requestId: 'r' } }],
    ['缺少 requestId', { error: { code: 'X', message: 'x' } }],
    ['message 为空', { error: { code: 'X', message: '', requestId: 'r' } }],
    ['requestId 为空', { error: { code: 'X', message: 'x', requestId: '' } }],
  ])('拒绝%s', (_case, input) => {
    expect(errorResponseSchema.safeParse(input).success).toBe(false)
  })

  it.each(['document_not_found', 'Document', '1_X', 'X-Y', ''])('拒绝不是大写下划线形式的错误码 %s', (code) => {
    expect(errorResponseSchema.safeParse({ error: { ...valid.error, code } }).success).toBe(false)
  })

  it('拒绝多余的字段，避免把内部细节带给客户端', () => {
    expect(errorResponseSchema.safeParse({ error: { ...valid.error, stack: 'at x' } }).success).toBe(false)
    expect(errorResponseSchema.safeParse({ ...valid, debug: true }).success).toBe(false)
  })
})
