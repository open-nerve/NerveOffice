// 修订记录与回执的保留期清理（M3-P3 设计 §3.9）：保留的天数取自配置、时刻与一批的数量原样交给仓储、两样都在调用方的事务里。
// 真实的 SQL（早于保留期、不是当前修订、只锁要删的行、跳过别人锁着的）由集成测试用真实数据库覆盖（tests/integration 的 jobs/revision-purge.test.ts）。
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import type { DocumentSaveReceiptsRepository } from './document-save-receipts.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { RevisionPurgeService } from './revision-purge.service.ts'

const NOW = new Date('2026-11-04T03:00:00.000Z')
const TRANSACTION = { held: 'revision-purge' } as unknown as Transaction

function setup(retentionDays: number) {
  const revisions = { deleteExpired: vi.fn(async () => 3) }
  const receipts = { deleteExpired: vi.fn(async () => 1) }
  const config = { revisions: { retentionDays } } as AppConfig
  const service = new RevisionPurgeService(revisions as unknown as DocumentRevisionsRepository, receipts as unknown as DocumentSaveReceiptsRepository, config)
  return { service, revisions, receipts }
}

describe('RevisionPurgeService.purgeExpired', () => {
  it('一批：修订记录与回执各删至多一批，保留的天数取自配置，时刻与条数原样交给仓储，都在调用方的事务里', async () => {
    const { service, revisions, receipts } = setup(30)
    await expect(service.purgeExpired(NOW, 500, TRANSACTION)).resolves.toEqual({ revisions: 3, receipts: 1 })
    expect(revisions.deleteExpired).toHaveBeenCalledExactlyOnceWith(NOW, 30, 500, TRANSACTION)
    expect(receipts.deleteExpired).toHaveBeenCalledExactlyOnceWith(NOW, 30, 500, TRANSACTION)
  })

  it('保留的天数改了（NERVE_REVISION_RETENTION_DAYS）：按改过的算', async () => {
    const { service, revisions, receipts } = setup(15)
    await service.purgeExpired(NOW, 2, TRANSACTION)
    expect(revisions.deleteExpired).toHaveBeenCalledWith(NOW, 15, 2, TRANSACTION)
    expect(receipts.deleteExpired).toHaveBeenCalledWith(NOW, 15, 2, TRANSACTION)
  })
})
