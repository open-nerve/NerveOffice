import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, securityHeaders, STRICT_TRANSPORT_SECURITY } from './security-headers.ts'

function run(secure: boolean): Map<string, string> {
  const headers = new Map<string, string>()
  const response = { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as Response
  let called = false
  securityHeaders()({ secure } as Request, response, () => {
    called = true
  })
  expect(called).toBe(true)
  return headers
}

describe('安全响应头', () => {
  it('CSP 与 M0 定稿的策略逐字一致（00 号计划书 §11.3；放宽要先写 ADR）', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      'default-src \'self\'; img-src \'self\' data: blob:; connect-src \'self\'; font-src \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\'; worker-src \'self\'; frame-ancestors \'none\'; base-uri \'self\'; form-action \'self\'',
    )
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval')
  })

  it('每个响应都写入全部安全头', () => {
    expect(Object.fromEntries(run(false))).toEqual(SECURITY_HEADERS)
    expect(SECURITY_HEADERS['Cache-Control']).toBe('no-store')
  })

  it('HSTS 只在 HTTPS 请求上下发', () => {
    expect(run(false).has('Strict-Transport-Security')).toBe(false)
    expect(run(true).get('Strict-Transport-Security')).toBe(STRICT_TRANSPORT_SECURITY)
  })
})
