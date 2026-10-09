import { describe, expect, it } from 'vitest'
import { LOCAL_DRAFT_RETENTION_DAYS } from './local-drafts.ts'

describe('本机草稿的保留期（00 号计划书 §7.5，M4 总设计 §2.2）', () => {
  it('14 天：前端按它清理本机发件箱，服务端修订记录保留期的下限由它推出', () => {
    expect(LOCAL_DRAFT_RETENTION_DAYS).toBe(14)
  })
})
