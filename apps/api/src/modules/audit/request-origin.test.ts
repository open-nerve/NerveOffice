import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { originOf } from './request-origin.ts'

function request(ip: string | undefined): Request {
  return { id: 'req-1', ip } as unknown as Request
}

describe('originOf', () => {
  it.each(['127.0.0.1', '::1', '::ffff:10.0.0.8', '2001:db8::1'])('合法的地址 %s 写进来源', (ip) => {
    expect(originOf(request(ip))).toEqual({ source: 'http', requestId: 'req-1', clientIp: ip })
  })

  it.each([undefined, 'fe80::1%lo0', 'unknown', ''])('存不进数据库的地址（%s）不写，审计照常', (ip) => {
    expect(originOf(request(ip))).toEqual({ source: 'http', requestId: 'req-1' })
  })
})
