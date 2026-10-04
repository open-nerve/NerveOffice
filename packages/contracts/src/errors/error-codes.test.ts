import { describe, expect, it } from 'vitest'
import { ERROR_CODES, errorStatus, RETIRED_ERROR_CODES } from './error-codes.ts'
import { errorCodeSchema } from './error-response.ts'

const entries = Object.entries(ERROR_CODES)

describe('错误码登记表', () => {
  it.each(entries)('%s 的写法合规，状态码是 4xx 或 5xx，有默认说明', (code, definition) => {
    expect(errorCodeSchema.safeParse(code).success).toBe(true)
    expect(Number.isInteger(definition.status)).toBe(true)
    expect(definition.status).toBeGreaterThanOrEqual(400)
    expect(definition.status).toBeLessThan(600)
    expect(definition.message.trim()).not.toBe('')
  })

  it('退役的错误码不得重新启用', () => {
    const active = new Set(Object.keys(ERROR_CODES))
    expect(RETIRED_ERROR_CODES.filter(code => active.has(code))).toEqual([])
  })

  it('每个错误码的 HTTP 状态固定', () => {
    expect(errorStatus('NOT_FOUND')).toBe(404)
    expect(errorStatus('INTERNAL_ERROR')).toBe(500)
  })

  it('M3-P3：页面过旧与文档比服务端新都是 409（4xx：页面确定这次没有提交）；快照不合法是 422（M1 起）', () => {
    expect([errorStatus('CLIENT_OUTDATED'), errorStatus('DOCUMENT_TOO_NEW'), errorStatus('SNAPSHOT_INVALID')]).toEqual([409, 409, 422])
    expect(ERROR_CODES.CLIENT_OUTDATED.message).toBe('页面的版本过旧，本次操作没有生效，请重新加载页面')
    expect(ERROR_CODES.DOCUMENT_TOO_NEW.message).toBe('这份文档由更新的版本保存过，当前只能阅读')
  })
})
