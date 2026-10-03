import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentTransferService } from './document-transfer.service.ts'

const FROM = '0199a2c4-0000-7000-8000-0000000000e2'
const TO = '0199a2c4-0000-7000-8000-0000000000e1'
const A = '0199a2c4-0000-7000-8000-0000000000d1'
const B = '0199a2c4-0000-7000-8000-0000000000d2'
const TRANSACTION = { transaction: true } as never

function setup(locked: string[]) {
  const repository = {
    lockForTransfer: vi.fn(async () => locked),
    moveToSpace: vi.fn(async () => []),
    listAccessible: vi.fn(async () => []),
  }
  const writeAccess = { revoke: vi.fn(async () => {}) }
  return { service: new DocumentTransferService(repository as never, writeAccess), repository, writeAccess }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('DocumentTransferService.transfer', () => {
  it('都还在来源空间里：只在来源空间里锁住，移到目标空间；id 去重', async () => {
    const { service, repository } = setup([A, B])
    expect(await service.transfer([B, A, B], FROM, TO, TRANSACTION)).toEqual([A, B])
    expect(repository.lockForTransfer).toHaveBeenCalledWith([B, A], FROM, TRANSACTION)
    // 目标位置是目标空间的根目录：文件夹属于某一个空间，转过去之后不能留在来源空间的文件夹里（M2-P4）
    expect(repository.moveToSpace).toHaveBeenCalledWith([A, B], TO, null, TRANSACTION)
  })

  it('跨空间搬文档：在同一个事务里经入口收回这些文档上的写入权，与跨空间移动一样（M2-P6 复核 A 的 G2、B 的 S-5）', async () => {
    const { service, repository, writeAccess } = setup([A, B])
    await service.transfer([B, A], FROM, TO, TRANSACTION)
    expect(writeAccess.revoke).toHaveBeenCalledTimes(1)
    expect(writeAccess.revoke).toHaveBeenCalledWith({ kind: 'documents', documentIds: [A, B] }, TRANSACTION)
    // 收回的是搬过去的那一批：在改所属空间之后（同一个事务里，M3 的实现按变化之后的权限判断）
    expect(repository.moveToSpace.mock.invocationCallOrder[0]).toBeLessThan(writeAccess.revoke.mock.invocationCallOrder[0] ?? 0)
  })

  it('锁住的少了一份（不在来源空间里、不存在或不是正常状态）：整批拒绝，TRANSFER_CONFLICT，不移动，也不收回写入权', async () => {
    for (const locked of [[A], []]) {
      const { service, repository, writeAccess } = setup(locked)
      expect((await rejection(service.transfer([A, B], FROM, TO, TRANSACTION))).code).toBe('TRANSFER_CONFLICT')
      expect(repository.moveToSpace).not.toHaveBeenCalled()
      expect(writeAccess.revoke).not.toHaveBeenCalled()
    }
  })
})

describe('DocumentTransferService.titles', () => {
  it('游标不合法：REQUEST_INVALID，不查询', async () => {
    const { service, repository } = setup([])
    expect((await rejection(service.titles(FROM, 'broken', TRANSACTION))).code).toBe('REQUEST_INVALID')
    expect(repository.listAccessible).not.toHaveBeenCalled()
  })
})
