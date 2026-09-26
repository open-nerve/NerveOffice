import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { sheetSnapshotFor, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentCreationService } from './document-creation.service.ts'
import { ALICE, ALICE_SPACE, BOB, FakeStore, HTTP_ORIGIN } from './documents.test-support.ts'
import { createdPayloadDigest } from './payload-digest.ts'

const REQUEST_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'

function setup() {
  const store = new FakeStore()
  const { transactions, documents, contents, revisions, spaces, policy, audit } = store.deps
  const service = new DocumentCreationService(transactions, documents, contents, revisions, spaces, policy, audit)
  return { store, service }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('DocumentCreationService.create', () => {
  it('在个人空间里新建：模板快照换上新的 unitId，修订号 1，档案、格式与 SDK 版本，写修订记录与审计', async () => {
    const { store, service } = setup()
    const detail = await service.create(ALICE, { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)

    expect(detail).toMatchObject({ title: '周报', type: 'sheet', spaceId: ALICE_SPACE, revision: 1, profile: 'sheet@1', formatVersion: 1, permissions: { canEdit: true } })
    expect(store.repositories.documents.insert).toHaveBeenCalledWith(expect.objectContaining({ createdBy: ALICE, profile: 'sheet@1', formatVersion: 1, sdkVersion: UNIVER_SDK_VERSION }), expect.anything())
    const row = store.documents.get(detail.id)
    expect(row?.unitId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    const stored = store.contents.get(detail.id)
    const raw = zlib.gunzipSync(stored?.snapshot ?? Buffer.alloc(0)).toString('utf8')
    expect(raw).toBe(sheetSnapshotFor(row?.unitId ?? ''))
    expect(stored?.rawBytes).toBe(Buffer.byteLength(raw))

    expect(store.revisions).toEqual([expect.objectContaining({ documentId: detail.id, revision: 1, kind: 'created', requestId: REQUEST_ID, source: null, savedBy: ALICE })])
    expect(store.revisions[0]?.payloadDigest).toEqual(createdPayloadDigest('sheet', '周报'))
    expect(store.audits).toEqual([{ action: 'documents.created', actor: { type: 'user', id: ALICE }, target: { type: 'document', id: detail.id }, origin: HTTP_ORIGIN, details: { revision: 1 } }])
  })

  it('没有标题用默认标题；每份文档的 unitId 各不相同', async () => {
    const { store, service } = setup()
    const first = await service.create(ALICE, { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN)
    const second = await service.create(ALICE, { type: 'sheet', requestId: '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0e' }, HTTP_ORIGIN)
    expect(first.title).toBe('未命名表格')
    expect(store.documents.get(first.id)?.unitId).not.toBe(store.documents.get(second.id)?.unitId)
  })

  it('先按 requestId 排队，再查修订记录', async () => {
    const { store, service } = setup()
    await service.create(ALICE, { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN)
    const lock = store.repositories.revisions.lockCreateRequest.mock.invocationCallOrder[0] ?? Number.NaN
    const lookup = store.repositories.revisions.findByRequestId.mock.invocationCallOrder[0] ?? Number.NaN
    expect(store.repositories.revisions.lockCreateRequest).toHaveBeenCalledWith(REQUEST_ID, expect.anything())
    expect(lock).toBeLessThan(lookup)
  })

  it('同一个请求重放：返回同一份文档的当前元数据，不再新建', async () => {
    const { store, service } = setup()
    const first = await service.create(ALICE, { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)
    const current = store.documents.get(first.id)
    if (current !== undefined)
      store.documents.set(first.id, { ...current, revision: 4 })
    const again = await service.create(ALICE, { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)
    expect(again).toEqual({ ...first, revision: 4 })
    expect(store.documents.size).toBe(1)
    expect(store.audits).toHaveLength(1)
  })

  it('同一个 requestId、不同的负载：REQUEST_ID_CONFLICT', async () => {
    const { service } = setup()
    await service.create(ALICE, { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)
    expect((await rejection(service.create(ALICE, { type: 'sheet', title: '月报', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('别人用过的 requestId：REQUEST_ID_CONFLICT，不透露那份文档', async () => {
    const { service } = setup()
    await service.create(ALICE, { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)
    const error = await rejection(service.create(BOB, { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN))
    expect(error.code).toBe('REQUEST_ID_CONFLICT')
    expect(error.details).toBeUndefined()
  })

  it('用于保存的 requestId：REQUEST_ID_CONFLICT', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    store.addRevision({ documentId: document.id, revision: 2, kind: 'saved', requestId: REQUEST_ID, payloadDigest: createdPayloadDigest('sheet', '未命名表格'), source: { clientInstanceId: REQUEST_ID, localSeq: 1 }, savedBy: ALICE })
    expect((await rejection(service.create(ALICE, { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('重放时已经不能访问那份文档：REQUEST_ID_CONFLICT', async () => {
    const { store, service } = setup()
    await service.create(ALICE, { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN)
    store.access.clear()
    expect((await rejection(service.create(ALICE, { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('写修订记录时 requestId 刚被一次保存用掉：REQUEST_ID_CONFLICT（事务回滚）', async () => {
    const { store, service } = setup()
    store.repositories.revisions.insert.mockResolvedValueOnce(undefined)
    expect((await rejection(service.create(ALICE, { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.audits).toHaveLength(0)
  })

  it('没有个人空间是数据不一致：意外错误', async () => {
    const { store, service } = setup()
    store.spaces.personalSpaceOf.mockResolvedValueOnce(undefined as never)
    await expect(service.create(ALICE, { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN)).rejects.toThrow('账户没有个人空间')
  })
})
