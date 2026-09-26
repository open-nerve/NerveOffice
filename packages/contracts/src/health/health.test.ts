import { describe, expect, it } from 'vitest'
import { healthLiveResponseSchema, healthReadyResponseSchema } from './health.ts'

describe('健康检查的响应结构', () => {
  it('存活与就绪各只有一个固定的状态值', () => {
    expect(healthLiveResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' })
    expect(healthReadyResponseSchema.parse({ status: 'ready' })).toEqual({ status: 'ready' })
    expect(healthLiveResponseSchema.safeParse({ status: 'ready' }).success).toBe(false)
    expect(healthReadyResponseSchema.safeParse({ status: 'ok' }).success).toBe(false)
    expect(healthReadyResponseSchema.parse({ status: 'ready', extra: 1 })).toEqual({ status: 'ready' })
  })
})
