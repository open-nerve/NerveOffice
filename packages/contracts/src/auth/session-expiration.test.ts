import { beforeAll, describe, expect, it } from 'vitest'
import { sessionExpiredDetailsSchema } from '../index.ts'

const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'

beforeAll(() => {
  expect(sessionExpiredDetailsSchema, '通过公共入口提供会话失效的运行时契约').toBeDefined()
})

describe('会话失效详情：只有已识别会话能带具体原因与用户', () => {
  it.each(['account_disabled', 'password_reset', 'password_changed', 'replaced', 'logout'])('%s 必须带真实识别出的 userId', (reason) => {
    expect(sessionExpiredDetailsSchema.parse({ reason, userId: USER_ID })).toEqual({ reason, userId: USER_ID })
    expect(sessionExpiredDetailsSchema.safeParse({ reason }).success).toBe(false)
    expect(sessionExpiredDetailsSchema.safeParse({ reason, userId: 'unknown' }).success).toBe(false)
  })

  it('无法识别的令牌只说明 expired；识别到的自然到期会话可以带用户', () => {
    expect(sessionExpiredDetailsSchema.parse({ reason: 'expired' })).toEqual({ reason: 'expired' })
    expect(sessionExpiredDetailsSchema.parse({ reason: 'expired', userId: USER_ID })).toEqual({ reason: 'expired', userId: USER_ID })
    expect(sessionExpiredDetailsSchema.safeParse({ reason: 'expired', userId: null }).success).toBe(false)
  })

  it.each([undefined, null, {}, [], { reason: 'disabled', userId: USER_ID }, { reason: 'future', userId: USER_ID }])('旧后端缺详情或未知形状 %j 不能解释成停用', (details) => {
    expect(sessionExpiredDetailsSchema.safeParse(details).success).toBe(false)
  })

  it('兼容响应中的未来字段，丢弃它们', () => {
    expect(sessionExpiredDetailsSchema.parse({ reason: 'account_disabled', userId: USER_ID, future: true }))
      .toEqual({ reason: 'account_disabled', userId: USER_ID })
  })
})
