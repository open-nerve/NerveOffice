import type { AuditEvent } from './audit-event.ts'
import { Test } from '@nestjs/testing'
import { describe, expect, it, vi } from 'vitest'
import { AuditRepository } from './audit.repository.ts'
import { AuditService } from './audit.service.ts'

const event: AuditEvent = { action: 'auth.logout', actor: { type: 'system' }, origin: { source: 'cli' } }

async function setup() {
  const repository = { insert: vi.fn(async () => {}) }
  // AuditService 的构造参数只按类型声明：能经依赖注入取得，说明装饰器元数据已经输出（ADR-004 的验证项）
  const moduleRef = await Test.createTestingModule({
    providers: [AuditService, { provide: AuditRepository, useValue: repository }],
  }).compile()
  return { service: moduleRef.get(AuditService), repository }
}

describe('AuditService', () => {
  it('校验后交给仓储写入，事务原样传下去', async () => {
    const { service, repository } = await setup()
    const transaction = {} as never
    await service.record(event, { transaction })
    expect(repository.insert).toHaveBeenCalledWith(event, transaction)
  })

  it('事件不合法时直接抛出，不写入', async () => {
    const { service, repository } = await setup()
    await expect(service.record({ ...event, action: 'x' } as unknown as AuditEvent)).rejects.toThrow()
    expect(repository.insert).not.toHaveBeenCalled()
  })
})
