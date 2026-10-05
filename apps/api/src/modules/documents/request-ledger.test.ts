// 写入的 requestId（RequestLedger，M3-P3 审查 A3）：锁、两张表里的记录、新建一类的请求遇到回执。真实的 advisory lock 与并发由集成测试覆盖
// （documents/request-ids.test.ts），这里的假仓储只记下调用的先后
import type { Transaction } from '../database/index.ts'
import type { RevisionRow } from './document-revisions.repository.ts'
import type { ReceiptRow } from './document-save-receipts.repository.ts'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { FakeStore } from './documents.test-support.ts'
import { isRecorded } from './request-ledger.ts'

const REQUEST_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const TRANSACTION = { name: '事务' } as unknown as Transaction
const AT = new Date('2026-10-05T08:00:00.000Z')
const REVISION: RevisionRow = { documentId: 'd', revision: 1, kind: 'created', payloadDigest: Buffer.alloc(32), savedBy: 'u', createdAt: AT, source: null }
const RECEIPT: ReceiptRow = { requestId: REQUEST_ID, documentId: 'd', revision: 3, payloadDigest: Buffer.alloc(32), savedBy: 'u', savedAt: AT }

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('isRecorded', () => {
  it('两边都没有：没有记录；有任何一边就是用过了（不论是不是这一次）', () => {
    expect(isRecorded({ revision: undefined, receipt: undefined })).toBe(false)
    expect(isRecorded({ revision: REVISION, receipt: undefined })).toBe(true)
    expect(isRecorded({ revision: undefined, receipt: RECEIPT })).toBe(true)
  })
})

describe('RequestLedger', () => {
  it('lock：在这个事务里取这个 requestId 的锁', async () => {
    const store = new FakeStore()
    await store.ledger.lock(REQUEST_ID, TRANSACTION)
    expect(store.repositories.revisions.lockRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, TRANSACTION)
  })

  it('recorded：两张表里的记录；不带事务时在连接池上读（重放预检）', async () => {
    const store = new FakeStore()
    store.receipts.push(RECEIPT)
    expect(await store.ledger.recorded(REQUEST_ID)).toEqual({ revision: undefined, receipt: RECEIPT })
    expect(store.repositories.revisions.findByRequestId).toHaveBeenCalledWith(REQUEST_ID, undefined)
    expect(store.repositories.receipts.findByRequestId).toHaveBeenCalledWith(REQUEST_ID, undefined)
    await store.ledger.recorded(REQUEST_ID, TRANSACTION)
    expect(store.repositories.receipts.findByRequestId).toHaveBeenLastCalledWith(REQUEST_ID, TRANSACTION)
    expect(store.repositories.revisions.lockRequest).not.toHaveBeenCalled()
  })

  it('lockForCreated：先取锁再查两张表；没有记录时 undefined，有修订记录时交给调用方判断重放', async () => {
    const store = new FakeStore()
    expect(await store.ledger.lockForCreated(REQUEST_ID, TRANSACTION)).toBeUndefined()
    const lock = store.repositories.revisions.lockRequest.mock.invocationCallOrder[0] ?? Number.NaN
    expect(lock).toBeLessThan(store.repositories.revisions.findByRequestId.mock.invocationCallOrder[0] ?? Number.NaN)
    expect(lock).toBeLessThan(store.repositories.receipts.findByRequestId.mock.invocationCallOrder[0] ?? Number.NaN)
    const document = store.addDocument()
    const created = store.addRevision({ documentId: document.id, revision: 1, kind: 'created', requestId: REQUEST_ID, payloadDigest: Buffer.alloc(32), source: null, savedBy: 'u' })
    expect(await store.ledger.lockForCreated(REQUEST_ID, TRANSACTION)).toEqual(created)
  })

  it('lockForCreated：只有回执（那是一次内容相同的保存）：REQUEST_ID_CONFLICT', async () => {
    const store = new FakeStore()
    store.receipts.push(RECEIPT)
    expect((await rejection(store.ledger.lockForCreated(REQUEST_ID, TRANSACTION))).code).toBe('REQUEST_ID_CONFLICT')
  })
})
