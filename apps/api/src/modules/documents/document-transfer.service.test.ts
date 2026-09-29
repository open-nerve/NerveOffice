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
    moveToSpace: vi.fn(async () => {}),
    listAccessible: vi.fn(async () => []),
  }
  return { service: new DocumentTransferService(repository as never), repository }
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
    expect(repository.moveToSpace).toHaveBeenCalledWith([A, B], TO, TRANSACTION)
  })

  it('锁住的少了一份（不在来源空间里、不存在或不是正常状态）：整批拒绝，TRANSFER_CONFLICT，不移动', async () => {
    for (const locked of [[A], []]) {
      const { service, repository } = setup(locked)
      expect((await rejection(service.transfer([A, B], FROM, TO, TRANSACTION))).code).toBe('TRANSFER_CONFLICT')
      expect(repository.moveToSpace).not.toHaveBeenCalled()
    }
  })
})

describe('DocumentTransferService.titles', () => {
  it('游标不合法：REQUEST_INVALID，不查询', async () => {
    const { service, repository } = setup([])
    expect((await rejection(service.titles(FROM, 'broken'))).code).toBe('REQUEST_INVALID')
    expect(repository.listAccessible).not.toHaveBeenCalled()
  })
})
