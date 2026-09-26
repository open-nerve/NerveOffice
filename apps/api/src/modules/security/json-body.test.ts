import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { toBodyError } from './json-body.ts'

describe('toBodyError', () => {
  it.each([
    ['entity.parse.failed', 'REQUEST_INVALID', '请求体不是合法的 JSON'],
    ['entity.too.large', 'PAYLOAD_TOO_LARGE', '请求体超过上限（1024 字节）'],
    ['request.size.invalid', 'REQUEST_INVALID', '请求体的长度与声明的不一致'],
    ['request.aborted', 'REQUEST_INVALID', '请求在传输中被中断'],
    ['charset.unsupported', 'UNSUPPORTED_MEDIA_TYPE', '请求体的字符集不受支持，只接受 UTF-8'],
    ['encoding.unsupported', 'UNSUPPORTED_MEDIA_TYPE', '请求体的内容编码不受支持'],
  ])('解析器的 %s 换成 %s', (type, code, message) => {
    const mapped = toBodyError(Object.assign(new Error('原始错误里可能有请求内容'), { type }), 1024)
    expect(mapped).toBeInstanceOf(AppError)
    expect(mapped).toMatchObject({ code, message })
  })

  it('认不出的错误原样交给异常过滤器', () => {
    const unknown = Object.assign(new Error('x'), { type: 'stream.not.readable' })
    expect(toBodyError(unknown, 1024)).toBe(unknown)
    expect(toBodyError('字符串', 1024)).toBe('字符串')
  })
})
