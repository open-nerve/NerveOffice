import type { AuditEvent } from './audit-event.ts'
import { Test } from '@nestjs/testing'
import { describe, expect, it, vi } from 'vitest'
import { AuditRepository } from './audit.repository.ts'
import { AuditService } from './audit.service.ts'

const event: AuditEvent = { action: 'auth.logout', actor: { type: 'system' }, origin: { source: 'cli' } }
const SPACE_ID = '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f'

async function setup() {
  const repository = { insert: vi.fn(async () => {}) }
  // AuditService 的构造参数只按类型声明：能经依赖注入取得，说明装饰器元数据已经输出（ADR-004 的验证项）
  const moduleRef = await Test.createTestingModule({
    providers: [AuditService, { provide: AuditRepository, useValue: repository }],
  }).compile()
  return { service: moduleRef.get(AuditService), repository }
}

describe('AuditService', () => {
  it('校验后交给仓储写入，事务原样传下去；没有给明细时按空对象写入', async () => {
    const { service, repository } = await setup()
    const transaction = {} as never
    await service.record(event, { transaction })
    expect(repository.insert).toHaveBeenCalledWith({ ...event, details: {} }, transaction)
  })

  it('事件不合法时直接抛出，不写入', async () => {
    const { service, repository } = await setup()
    await expect(service.record({ ...event, action: 'x' } as unknown as AuditEvent)).rejects.toThrow()
    expect(repository.insert).not.toHaveBeenCalled()
  })

  it('明细不符合这个动作的结构（例如文档改名带着标题）：直接抛出，不写入（M2-P6 复核 M-1）', async () => {
    const { service, repository } = await setup()
    const renamed = { action: 'documents.renamed', actor: { type: 'system' }, origin: { source: 'cli' }, details: { spaceId: SPACE_ID, folderId: null, to: '月报' } }
    await expect(service.record(renamed as unknown as AuditEvent)).rejects.toThrow()
    expect(repository.insert).not.toHaveBeenCalled()
  })
})
