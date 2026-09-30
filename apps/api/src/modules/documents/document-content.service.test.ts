import type { SaveContentQuery } from '@nerve-office/contracts'
import type { GzipBody } from '../security/index.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentContentService } from './document-content.service.ts'
import { ALICE, BOB, BOB_SPACE, FakeStore, HTTP_ORIGIN, TEAM_SPACE } from './documents.test-support.ts'
import { savedPayloadDigest } from './payload-digest.ts'

const CLIENT = '0199a2c4-1f2e-4a3b-8c4d-00000000c11e'
const OTHER_CLIENT = '0199a2c4-1f2e-4a3b-8c4d-00000000c22e'

function setup() {
  const store = new FakeStore()
  const { transactions, documents, contents, revisions, policy, audit } = store.deps
  const service = new DocumentContentService(transactions, documents, contents, revisions, policy, audit)
  const document = store.addDocument({ revision: 1 })
  store.contents.set(document.id, { snapshot: zlib.gzipSync('{}'), rawBytes: 2 })
  store.addRevision({ documentId: document.id, revision: 1, kind: 'created', requestId: '0199a2c4-1f2e-4a3b-8c4d-000000000001', payloadDigest: Buffer.alloc(32), source: null, savedBy: ALICE })
  return { store, service, document }
}

/** 团队空间里的一份文档（成员按用例另加） */
function teamDocument(store: FakeStore) {
  const document = store.addDocument({ spaceId: TEAM_SPACE, revision: 1 })
  store.contents.set(document.id, { snapshot: zlib.gzipSync('{}'), rawBytes: 2 })
  return document
}

function upload(unitId: string, extra = ''): GzipBody {
  const decompressed = Buffer.from(`{"id":"${unitId}","sheetOrder":[],"sheets":{}${extra}}`, 'utf8')
  return { compressed: zlib.gzipSync(decompressed), decompressed }
}

function query(overrides: Partial<SaveContentQuery> = {}): SaveContentQuery {
  return { baseRevision: 1, requestId: randomUUID(), clientInstanceId: CLIENT, localSeq: 5, ...overrides }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('DocumentContentService.read', () => {
  it('当前内容与它的修订号', async () => {
    const { store, service, document } = setup()
    expect(await service.read(ALICE, document.id)).toEqual({ revision: 1, snapshot: store.contentOf(document.id) })
  })

  it('别人的与不存在的：NOT_FOUND', async () => {
    const { service, document } = setup()
    expect((await rejection(service.read(BOB, document.id))).code).toBe('NOT_FOUND')
    expect((await rejection(service.read(ALICE, '0199a2c4-0000-7000-8000-0000000000ff'))).code).toBe('NOT_FOUND')
  })

  it('有记录却没有内容：意外错误，不伪装成 404', async () => {
    const { store, service, document } = setup()
    store.contents.clear()
    await expect(service.read(ALICE, document.id)).rejects.toThrow('文档有记录却没有内容')
  })
})

describe('DocumentContentService.save', () => {
  it('成功：修订号加一，换上客户端的 gzip 字节，修订记录带来源，写审计', async () => {
    const { store, service, document } = setup()
    const body = upload(document.unitId)
    const request = query()
    expect(await service.save(ALICE, document.id, request, body, HTTP_ORIGIN)).toEqual({ revision: 2, savedAt: '2026-09-27T08:00:00.000Z' })
    expect(store.documents.get(document.id)?.revision).toBe(2)
    expect(store.repositories.documents.advanceRevision).toHaveBeenCalledWith(document.id, 2, UNIVER_SDK_VERSION, expect.anything())
    expect(store.contents.get(document.id)).toEqual({ snapshot: body.compressed, rawBytes: body.decompressed.length })
    expect(store.revisions.at(-1)).toMatchObject({ documentId: document.id, revision: 2, kind: 'saved', requestId: request.requestId, source: { clientInstanceId: CLIENT, localSeq: 5 }, savedBy: ALICE })
    expect(store.revisions.at(-1)?.payloadDigest).toEqual(savedPayloadDigest(1, body.decompressed))
    expect(store.audits).toEqual([{ action: 'documents.content_saved', actor: { type: 'user', id: ALICE }, target: { type: 'document', id: document.id }, origin: HTTP_ORIGIN, details: { revision: 2 } }])
  })

  it('快照不合格：SNAPSHOT_INVALID，不开事务（与文档无关，别人的与不存在的结果相同）', async () => {
    const { store, service, document } = setup()
    const decompressed = Buffer.from('[1]', 'utf8')
    const error = await rejection(service.save(ALICE, document.id, query(), { compressed: zlib.gzipSync(decompressed), decompressed }, HTTP_ORIGIN))
    expect(error.code).toBe('SNAPSHOT_INVALID')
    expect(store.transactions.run).not.toHaveBeenCalled()
  })

  it('别人的与不存在的：NOT_FOUND；两者都判断一次权限', async () => {
    const { store, service, document } = setup()
    expect((await rejection(service.save(BOB, document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect((await rejection(service.save(ALICE, '0199a2c4-0000-7000-8000-0000000000ff', query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    // 两条路径各判断一次权限：同样的一条空间事实的查询，不存在的文档用全零的空间
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(2)
    expect(store.spaces.accessFactsOf).toHaveBeenLastCalledWith(ALICE, '00000000-0000-0000-0000-000000000000', expect.anything())
    expect(store.revisions).toHaveLength(1)
  })

  it('先判断权限再加锁：没有权限的请求不在别人的文档上取锁（审查 A2）', async () => {
    const { store, service, document } = setup()
    expect((await rejection(service.save(BOB, document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
    await service.save(ALICE, document.id, query(), upload(document.unitId), HTTP_ORIGIN)
    const checked = store.repositories.documents.findById.mock.invocationCallOrder.at(-1) ?? Number.NaN
    const locked = store.repositories.documents.lockById.mock.invocationCallOrder[0] ?? Number.NaN
    expect(checked).toBeLessThan(locked)
  })

  it('锁下再判断一次：加锁之前被移出了空间，按锁下的状态为准（复验 RA7）', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.repositories.documents.lockById.mockImplementationOnce(async (id: string) => {
      store.setMember(TEAM_SPACE, ALICE, undefined)
      return store.documents.get(id)
    })
    expect((await rejection(service.save(ALICE, document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.revisions).toHaveLength(1)
  })

  it('判断权限之后、加锁之前文档移到了别的空间：按锁下的状态再判断一次', async () => {
    const { store, service, document } = setup()
    store.repositories.documents.lockById.mockImplementationOnce(async () => ({ ...document, spaceId: BOB_SPACE }))
    expect((await rejection(service.save(ALICE, document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.revisions).toHaveLength(1)
  })

  it('判断权限之后文档被删了：NOT_FOUND', async () => {
    const { store, service, document } = setup()
    store.repositories.documents.lockById.mockResolvedValueOnce(undefined)
    expect((await rejection(service.save(ALICE, document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
  })

  it('只能查看：PERMISSION_DENIED，而且不取锁，不让能编辑的人的保存排队（复验 RA7）', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await rejection(service.save(BOB, document.id, query(), upload(document.unitId), HTTP_ORIGIN))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能保存' })
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
  })

  it('归档的空间里所有人至多是查看者：空间管理员同样不能保存，说明是"空间已归档"（与改名、移动、删除一致，M2-P6 复核 A 的 G3）', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect(await rejection(service.save(BOB, document.id, query(), upload(document.unitId), HTTP_ORIGIN))).toMatchObject({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
  })

  it('团队空间的编辑者可以保存', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'editor')
    expect(await service.save(BOB, document.id, query(), upload(document.unitId), HTTP_ORIGIN)).toMatchObject({ revision: 2 })
  })

  it('unitId 不是这份文档的：SNAPSHOT_INVALID', async () => {
    const { service, document } = setup()
    const error = await rejection(service.save(ALICE, document.id, query(), upload('another-unit'), HTTP_ORIGIN))
    expect(error).toMatchObject({ code: 'SNAPSHOT_INVALID', message: '表格内容不属于这份文档' })
  })

  it('基准修订号不是当前的：DOCUMENT_REVISION_CONFLICT，详情带当前修订号及其来源', async () => {
    const { store, service, document } = setup()
    await service.save(ALICE, document.id, query({ clientInstanceId: OTHER_CLIENT, localSeq: 9 }), upload(document.unitId), HTTP_ORIGIN)
    const error = await rejection(service.save(ALICE, document.id, query({ baseRevision: 1 }), upload(document.unitId, ',"x":1'), HTTP_ORIGIN))
    expect(error.code).toBe('DOCUMENT_REVISION_CONFLICT')
    expect(error.details).toEqual({ currentRevision: 2, source: { clientInstanceId: OTHER_CLIENT, localSeq: 9 } })
    expect(store.documents.get(document.id)?.revision).toBe(2)
  })

  it('当前修订是新建出来的：冲突的来源为 null', async () => {
    const { service, document } = setup()
    const error = await rejection(service.save(ALICE, document.id, query({ baseRevision: 7 }), upload(document.unitId), HTTP_ORIGIN))
    expect(error.details).toEqual({ currentRevision: 1, source: null })
  })

  it('同一个请求重放：返回原来的结果，不再写入（即使之后又有别的保存）', async () => {
    const { store, service, document } = setup()
    const request = query()
    const body = upload(document.unitId)
    const first = await service.save(ALICE, document.id, request, body, HTTP_ORIGIN)
    await service.save(ALICE, document.id, query({ baseRevision: 2 }), upload(document.unitId, ',"y":2'), HTTP_ORIGIN)
    // 客户端重试时压缩结果可以不同：按解压后的字节判断
    const again = await service.save(ALICE, document.id, request, { compressed: zlib.gzipSync(body.decompressed, { level: 1 }), decompressed: body.decompressed }, HTTP_ORIGIN)
    expect(again).toEqual(first)
    expect(store.documents.get(document.id)?.revision).toBe(3)
    expect(store.audits).toHaveLength(2)
  })

  it('同一个 requestId、不同的负载或别的文档、别的人：REQUEST_ID_CONFLICT', async () => {
    const { store, service, document } = setup()
    const request = query()
    await service.save(ALICE, document.id, request, upload(document.unitId), HTTP_ORIGIN)
    expect((await rejection(service.save(ALICE, document.id, request, upload(document.unitId, ',"z":3'), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect((await rejection(service.save(ALICE, document.id, { ...request, baseRevision: 2 }, upload(document.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')

    const another = store.addDocument({ revision: 2 })
    store.contents.set(another.id, { snapshot: zlib.gzipSync('{}'), rawBytes: 2 })
    expect((await rejection(service.save(ALICE, another.id, request, upload(another.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')

    const bobs = store.addDocument({ spaceId: BOB_SPACE, unitId: document.unitId })
    expect((await rejection(service.save(BOB, bobs.id, request, upload(document.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('新建用过的 requestId：REQUEST_ID_CONFLICT', async () => {
    const { store, service, document } = setup()
    const created = store.revisions[0]
    expect((await rejection(service.save(ALICE, document.id, query({ requestId: created?.requestId ?? '' }), upload(document.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('写修订记录时 requestId 刚被别处用掉：REQUEST_ID_CONFLICT，内容不变', async () => {
    const { store, service, document } = setup()
    const before = store.contentOf(document.id)
    store.repositories.revisions.insert.mockResolvedValueOnce(undefined)
    expect((await rejection(service.save(ALICE, document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.contentOf(document.id)).toBe(before)
    expect(store.repositories.documents.advanceRevision).not.toHaveBeenCalled()
  })

  it('有记录却没有内容行：意外错误', async () => {
    const { store, service, document } = setup()
    store.contents.clear()
    await expect(service.save(ALICE, document.id, query(), upload(document.unitId), HTTP_ORIGIN)).rejects.toThrow('文档有记录却没有内容')
  })
})
