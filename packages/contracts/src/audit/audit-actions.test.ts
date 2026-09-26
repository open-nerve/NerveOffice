import { describe, expect, it } from 'vitest'
import { AUDIT_ACTIONS, auditActionSchema } from './audit-actions.ts'

describe('审计动作', () => {
  it('写法是"模块.动作"，没有重复', () => {
    for (const action of AUDIT_ACTIONS)
      expect(action).toMatch(/^[a-z]+\.[a-z]+(?:_[a-z]+)*$/)
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length)
  })

  it('只接受登记过的动作', () => {
    expect(auditActionSchema.parse('documents.created')).toBe('documents.created')
    expect(auditActionSchema.safeParse('documents.deleted').success).toBe(false)
  })
})
