import type { SaveContentQuery } from '@nerve-office/contracts'
import type { GzipBody } from '../security/index.ts'
import type { ContentSaver } from './document-content.service.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { EDIT_LEASE_TTL_SECONDS, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentContentService } from './document-content.service.ts'
import { ALICE, BOB, BOB_SPACE, FakeStore, HTTP_ORIGIN, TEAM_SPACE } from './documents.test-support.ts'
import { editLeaseTokenDigest } from './edit-lease-token.ts'
import { savedPayloadDigest } from './payload-digest.ts'

const CLIENT = '0199a2c4-1f2e-4a3b-8c4d-00000000c11e'
const OTHER_CLIENT = '0199a2c4-1f2e-4a3b-8c4d-00000000c22e'
/** 每个人这次的登录与他手里的编辑租约令牌（M3-P1 起保存要求租约，holding 摆好对应的租约） */
const SESSIONS: Readonly<Record<string, string>> = { [ALICE]: '0199a2c4-1f2e-4a3b-8c4d-0000000005e1', [BOB]: '0199a2c4-1f2e-4a3b-8c4d-0000000005e2' }
const TOKENS: Readonly<Record<string, string>> = { [ALICE]: `${'a'.repeat(41)}-_`, [BOB]: `${'b'.repeat(41)}-_` }

/** 谁在保存：这个人、他这次的登录与他手里的令牌 */
function saver(userId: string, overrides: Partial<ContentSaver> = {}): ContentSaver {
  return { userId, sessionId: SESSIONS[userId] ?? '', token: TOKENS[userId], ...overrides }
}

/**
 * 这个人以这个标签页持有这份文档当前这一代的有效租约（假仓储里直接摆好：申请的流程在 edit-lease.service.test.ts，
 * 有效条件在 edit-lease-rules.test.ts）。原有的用例在保存之前都这样摆好——它们要验证的是租约之外的步骤
 */
function holding(store: FakeStore, documentId: string, userId: string, clientInstanceId = CLIENT): void {
  const now = store.databaseNow
  store.leaseRecords.set(documentId, {
    documentId,
    holderId: userId,
    sessionId: SESSIONS[userId] ?? '',
    clientInstanceId,
    tokenDigest: editLeaseTokenDigest(TOKENS[userId] ?? ''),
    writeEpoch: store.documents.get(documentId)?.writeEpoch ?? 0,
    acquiredAt: now,
    renewedAt: now,
    lastActiveAt: now,
    expiresAt: new Date(now.getTime() + EDIT_LEASE_TTL_SECONDS * 1000),
    endedAt: null,
    endReason: null,
  })
}

function setup() {
  const store = new FakeStore()
  // 两人这次的登录都有效（会话守卫放行过；保存在锁下再查一次，M3-P1 审查 A1）
  for (const session of Object.values(SESSIONS))
    store.activeSessions.add(session)
  const { transactions, documents, contents, revisions, leases, sessions, policy, audit } = store.deps
  const service = new DocumentContentService(transactions, documents, contents, revisions, leases, sessions, policy, audit)
  const document = store.addDocument({ revision: 1 })
  store.contents.set(document.id, { snapshot: zlib.gzipSync('{}'), rawBytes: 2 })
  store.addRevision({ documentId: document.id, revision: 1, kind: 'created', requestId: '0199a2c4-1f2e-4a3b-8c4d-000000000001', payloadDigest: Buffer.alloc(32), source: null, savedBy: ALICE })
  holding(store, document.id, ALICE)
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
  return { baseRevision: 1, requestId: randomUUID(), clientInstanceId: CLIENT, localSeq: 5, writeEpoch: 0, ...overrides }
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
    expect(await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)).toEqual({ revision: 2, savedAt: '2026-09-27T08:00:00.000Z' })
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
    const error = await rejection(service.save(saver(ALICE), document.id, query(), { compressed: zlib.gzipSync(decompressed), decompressed }, HTTP_ORIGIN))
    expect(error.code).toBe('SNAPSHOT_INVALID')
    expect(store.transactions.run).not.toHaveBeenCalled()
  })

  it('别人的与不存在的：NOT_FOUND；两者都判断一次权限', async () => {
    const { store, service, document } = setup()
    expect((await rejection(service.save(saver(BOB), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect((await rejection(service.save(saver(ALICE), '0199a2c4-0000-7000-8000-0000000000ff', query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    // 两条路径各判断一次权限：同样的一条空间事实的查询，不存在的文档用全零的空间
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(2)
    expect(store.spaces.accessFactsOf).toHaveBeenLastCalledWith(ALICE, '00000000-0000-0000-0000-000000000000', expect.anything())
    expect(store.revisions).toHaveLength(1)
  })

  it('先判断权限再加锁：没有权限的请求不在别人的文档上取锁（审查 A2）', async () => {
    const { store, service, document } = setup()
    expect((await rejection(service.save(saver(BOB), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
    await service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN)
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
    expect((await rejection(service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.revisions).toHaveLength(1)
  })

  it('判断权限之后、加锁之前文档移到了别的空间：按锁下的状态再判断一次', async () => {
    const { store, service, document } = setup()
    store.repositories.documents.lockById.mockImplementationOnce(async () => ({ ...document, spaceId: BOB_SPACE }))
    expect((await rejection(service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.revisions).toHaveLength(1)
  })

  it('判断权限之后文档被删了：NOT_FOUND', async () => {
    const { store, service, document } = setup()
    store.repositories.documents.lockById.mockResolvedValueOnce(undefined)
    expect((await rejection(service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
  })

  it('只能查看：PERMISSION_DENIED，而且不取锁，不让能编辑的人的保存排队（复验 RA7）', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await rejection(service.save(saver(BOB), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能编辑' })
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
  })

  it('归档的空间里所有人至多是查看者：空间管理员同样不能保存，说明是"空间已归档"（与改名、移动、删除一致，M2-P6 复核 A 的 G3）', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect(await rejection(service.save(saver(BOB), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).toMatchObject({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
  })

  it('团队空间的编辑者可以保存', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'editor')
    holding(store, document.id, BOB)
    expect(await service.save(saver(BOB), document.id, query(), upload(document.unitId), HTTP_ORIGIN)).toMatchObject({ revision: 2 })
  })

  it('unitId 不是这份文档的：SNAPSHOT_INVALID', async () => {
    const { service, document } = setup()
    const error = await rejection(service.save(saver(ALICE), document.id, query(), upload('another-unit'), HTTP_ORIGIN))
    expect(error).toMatchObject({ code: 'SNAPSHOT_INVALID', message: '表格内容不属于这份文档' })
  })

  it('基准修订号不是当前的：DOCUMENT_REVISION_CONFLICT，详情带当前修订号及其来源', async () => {
    const { store, service, document } = setup()
    // 另一个标签页先保存（M3-P1 起同一时刻只有一个标签页能写）：它持有租约时保存，释放之后这个标签页才申请到租约、基于旧修订号保存
    holding(store, document.id, ALICE, OTHER_CLIENT)
    await service.save(saver(ALICE), document.id, query({ clientInstanceId: OTHER_CLIENT, localSeq: 9 }), upload(document.unitId), HTTP_ORIGIN)
    holding(store, document.id, ALICE)
    const error = await rejection(service.save(saver(ALICE), document.id, query({ baseRevision: 1 }), upload(document.unitId, ',"x":1'), HTTP_ORIGIN))
    expect(error.code).toBe('DOCUMENT_REVISION_CONFLICT')
    expect(error.details).toEqual({ currentRevision: 2, source: { clientInstanceId: OTHER_CLIENT, localSeq: 9 } })
    expect(store.documents.get(document.id)?.revision).toBe(2)
  })

  it('当前修订是新建出来的：冲突的来源为 null', async () => {
    const { service, document } = setup()
    const error = await rejection(service.save(saver(ALICE), document.id, query({ baseRevision: 7 }), upload(document.unitId), HTTP_ORIGIN))
    expect(error.details).toEqual({ currentRevision: 1, source: null })
  })

  it('同一个请求重放：返回原来的结果，不再写入（即使之后又有别的保存）', async () => {
    const { store, service, document } = setup()
    const request = query()
    const body = upload(document.unitId)
    const first = await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)
    await service.save(saver(ALICE), document.id, query({ baseRevision: 2 }), upload(document.unitId, ',"y":2'), HTTP_ORIGIN)
    // 客户端重试时压缩结果可以不同：按解压后的字节判断
    const again = await service.save(saver(ALICE), document.id, request, { compressed: zlib.gzipSync(body.decompressed, { level: 1 }), decompressed: body.decompressed }, HTTP_ORIGIN)
    expect(again).toEqual(first)
    expect(store.documents.get(document.id)?.revision).toBe(3)
    expect(store.audits).toHaveLength(2)
  })

  it('重放只要求仍能访问（00 号计划书 §7.4 第 2 步，M2-P6 复核 A 的 S-4）：提交之后被降为查看者、空间被归档，重发拿到原来的结果，不取锁', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'editor')
    holding(store, document.id, BOB)
    const request = query()
    const body = upload(document.unitId)
    const first = await service.save(saver(BOB), document.id, request, body, HTTP_ORIGIN)
    store.repositories.documents.lockById.mockClear()

    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await service.save(saver(BOB), document.id, request, body, HTTP_ORIGIN)).toEqual(first)
    store.setMember(TEAM_SPACE, BOB, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect(await service.save(saver(BOB), document.id, request, body, HTTP_ORIGIN)).toEqual(first)
    // 只能查看的请求不在文档上取锁（复验 RA7）：重放也一样
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
    expect(store.documents.get(document.id)?.revision).toBe(2)
    expect(store.audits).toHaveLength(1)
  })

  it('只能查看时，不是重放的（摘要不同、新的请求标识）照样被拒绝：REQUEST_ID_CONFLICT 与 PERMISSION_DENIED', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'editor')
    holding(store, document.id, BOB)
    const request = query()
    await service.save(saver(BOB), document.id, request, upload(document.unitId), HTTP_ORIGIN)
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect((await rejection(service.save(saver(BOB), document.id, request, upload(document.unitId, ',"z":3'), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(await rejection(service.save(saver(BOB), document.id, query({ baseRevision: 2 }), upload(document.unitId), HTTP_ORIGIN))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能编辑' })
    expect(store.documents.get(document.id)?.revision).toBe(2)
  })

  it('等锁期间被降为查看者：锁下只要求能访问，先查重放——重放照样返回原来的结果，不是重放才是 PERMISSION_DENIED', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'editor')
    holding(store, document.id, BOB)
    const request = query()
    const body = upload(document.unitId)
    const first = await service.save(saver(BOB), document.id, request, body, HTTP_ORIGIN)
    const demoteWhileWaiting = async (id: string) => {
      store.setMember(TEAM_SPACE, BOB, 'viewer')
      return store.documents.get(id)
    }

    store.repositories.documents.lockById.mockImplementationOnce(demoteWhileWaiting)
    expect(await service.save(saver(BOB), document.id, request, body, HTTP_ORIGIN)).toEqual(first)
    store.setMember(TEAM_SPACE, BOB, 'editor')
    store.repositories.documents.lockById.mockImplementationOnce(demoteWhileWaiting)
    expect((await rejection(service.save(saver(BOB), document.id, query({ baseRevision: 2 }), upload(document.unitId), HTTP_ORIGIN))).code).toBe('PERMISSION_DENIED')
    expect(store.documents.get(document.id)?.revision).toBe(2)
  })

  it('看不到了（被移出空间）：重放也是 NOT_FOUND，不透露那份文档', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'editor')
    holding(store, document.id, BOB)
    const request = query()
    const body = upload(document.unitId)
    await service.save(saver(BOB), document.id, request, body, HTTP_ORIGIN)
    store.setMember(TEAM_SPACE, BOB, undefined)
    expect((await rejection(service.save(saver(BOB), document.id, request, body, HTTP_ORIGIN))).code).toBe('NOT_FOUND')
  })

  it('同一个 requestId、不同的负载或别的文档、别的人：REQUEST_ID_CONFLICT', async () => {
    const { store, service, document } = setup()
    const request = query()
    await service.save(saver(ALICE), document.id, request, upload(document.unitId), HTTP_ORIGIN)
    expect((await rejection(service.save(saver(ALICE), document.id, request, upload(document.unitId, ',"z":3'), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect((await rejection(service.save(saver(ALICE), document.id, { ...request, baseRevision: 2 }, upload(document.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')

    const another = store.addDocument({ revision: 2 })
    store.contents.set(another.id, { snapshot: zlib.gzipSync('{}'), rawBytes: 2 })
    expect((await rejection(service.save(saver(ALICE), another.id, request, upload(another.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')

    const bobs = store.addDocument({ spaceId: BOB_SPACE, unitId: document.unitId })
    expect((await rejection(service.save(saver(BOB), bobs.id, request, upload(document.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('新建用过的 requestId：REQUEST_ID_CONFLICT', async () => {
    const { store, service, document } = setup()
    const created = store.revisions[0]
    expect((await rejection(service.save(saver(ALICE), document.id, query({ requestId: created?.requestId ?? '' }), upload(document.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('写修订记录时 requestId 刚被别处用掉：REQUEST_ID_CONFLICT，内容不变', async () => {
    const { store, service, document } = setup()
    const before = store.contentOf(document.id)
    store.repositories.revisions.insert.mockResolvedValueOnce(undefined)
    expect((await rejection(service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.contentOf(document.id)).toBe(before)
    expect(store.repositories.documents.advanceRevision).not.toHaveBeenCalled()
  })

  it('有记录却没有内容行：意外错误', async () => {
    const { store, service, document } = setup()
    store.contents.clear()
    await expect(service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN)).rejects.toThrow('文档有记录却没有内容')
  })
})

describe('DocumentContentService.save：保存要求编辑租约（M3-P1 设计 §3.4.4）', () => {
  /** 这次保存被拒的原因（EDIT_LEASE_LOST 的 details），并核对什么也没写 */
  async function lostReason(setupResult: ReturnType<typeof setup>, run: Promise<unknown>): Promise<unknown> {
    const error = await rejection(run)
    expect([error.code, error.status]).toEqual(['EDIT_LEASE_LOST', 409])
    expect(setupResult.store.documents.get(setupResult.document.id)?.revision).toBe(1)
    expect(setupResult.store.audits).toEqual([])
    return (error.details as { reason?: unknown } | undefined)?.reason
  }

  it('租约对得上：写入；租约行只读不锁（文档行已经锁住），也不续租', async () => {
    const { store, service, document } = setup()
    expect(await service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN)).toMatchObject({ revision: 2 })
    expect(store.leases.findByDocument).toHaveBeenCalledWith(document.id, expect.anything())
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    expect(store.leases.renew).not.toHaveBeenCalled()
    // 租约在拿到文档行的锁之后才读
    expect(store.repositories.documents.lockById.mock.invocationCallOrder[0]).toBeLessThan(store.leases.findByDocument.mock.invocationCallOrder[0] ?? 0)
  })

  it('没带令牌、没有租约：none；令牌不是当前这一行的：replaced', async () => {
    const noToken = setup()
    expect(await lostReason(noToken, noToken.service.save(saver(ALICE, { token: undefined }), noToken.document.id, query(), upload(noToken.document.unitId), HTTP_ORIGIN))).toBe('none')
    const noLease = setup()
    noLease.store.leaseRecords.clear()
    expect(await lostReason(noLease, noLease.service.save(saver(ALICE), noLease.document.id, query(), upload(noLease.document.unitId), HTTP_ORIGIN))).toBe('none')
    const replaced = setup()
    expect(await lostReason(replaced, replaced.service.save(saver(ALICE, { token: TOKENS[BOB] }), replaced.document.id, query(), upload(replaced.document.unitId), HTTP_ORIGIN))).toBe('replaced')
  })

  it('代次：查询参数的 writeEpoch 不是租约的那一代、租约的那一代不是文档当前的（删除、移动、收回写入权之后）：stale', async () => {
    // 租约与文档都是第 0 代，页面带的却是别的一代
    const asked = setup()
    expect(await lostReason(asked, asked.service.save(saver(ALICE), asked.document.id, query({ writeEpoch: 1 }), upload(asked.document.unitId), HTTP_ORIGIN))).toBe('stale')
    // 页面带的就是租约的那一代（第 0 代），文档已经到了下一代：只有和文档当前的代次比才看得出来
    const moved = setup()
    await moved.store.repositories.documents.advanceWriteEpoch(moved.document.id)
    expect(await lostReason(moved, moved.service.save(saver(ALICE), moved.document.id, query(), upload(moved.document.unitId), HTTP_ORIGIN))).toBe('stale')
  })

  it('代次用锁下读到的文档行：拿到文档行的锁时代次已经变了（等锁期间被收回写入权、被移动），按新的代次判断，stale', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    store.repositories.documents.lockById.mockImplementationOnce(async (id: string) => {
      await store.repositories.documents.advanceWriteEpoch(id)
      return store.documents.get(id)
    })
    expect(await lostReason(setupResult, service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).toBe('stale')
  })

  it('到期、空闲、已释放：各自的原因', async () => {
    const expired = setup()
    expired.store.databaseNow = new Date(expired.store.databaseNow.getTime() + EDIT_LEASE_TTL_SECONDS * 1000)
    expect(await lostReason(expired, expired.service.save(saver(ALICE), expired.document.id, query(), upload(expired.document.unitId), HTTP_ORIGIN))).toBe('expired')
    const idle = setup()
    const row = idle.store.leaseRecords.get(idle.document.id)
    if (row !== undefined)
      idle.store.leaseRecords.set(idle.document.id, { ...row, lastActiveAt: new Date(row.renewedAt.getTime() - 720_000) })
    expect(await lostReason(idle, idle.service.save(saver(ALICE), idle.document.id, query(), upload(idle.document.unitId), HTTP_ORIGIN))).toBe('idle')
    const released = setup()
    await released.store.leases.end(released.document.id, 'released')
    expect(await lostReason(released, released.service.save(saver(ALICE), released.document.id, query(), upload(released.document.unitId), HTTP_ORIGIN))).toBe('released')
  })

  it('这次登录不是租约绑定的（换过令牌的旧页面）、保存的标签页不是租约绑定的：session', async () => {
    const otherSession = setup()
    expect(await lostReason(otherSession, otherSession.service.save(saver(ALICE, { sessionId: SESSIONS[BOB] }), otherSession.document.id, query(), upload(otherSession.document.unitId), HTTP_ORIGIN))).toBe('session')
    const otherTab = setup()
    expect(await lostReason(otherTab, otherTab.service.save(saver(ALICE), otherTab.document.id, query({ clientInstanceId: OTHER_CLIENT }), upload(otherTab.document.unitId), HTTP_ORIGIN))).toBe('session')
  })

  it('只能查看的请求到不了租约这一步：先被"能编辑"拒绝（403），不锁文档行、不读租约', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect((await rejection(service.save(saver(BOB, { token: undefined }), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('PERMISSION_DENIED')
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
    expect(store.leases.findByDocument).not.toHaveBeenCalled()
  })

  it('US-M3-13 重放先于租约（A07）：提交之后租约到期、被别人接手，重发同一个请求拿到原来的结果，修订号不变', async () => {
    const { store, service, document } = setup()
    const request = query()
    const body = upload(document.unitId)
    const first = await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)
    store.databaseNow = new Date(store.databaseNow.getTime() + EDIT_LEASE_TTL_SECONDS * 1000)
    holding(store, document.id, BOB)
    expect(await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)).toEqual(first)
    expect(store.documents.get(document.id)?.revision).toBe(2)
    expect(store.audits).toHaveLength(1)
  })

  it('租约在 unitId 与基准修订号的核对之前：没有租约时，unitId 不对、基准修订号过时都先得到编辑权已失效', async () => {
    const foreign = setup()
    foreign.store.leaseRecords.clear()
    expect((await rejection(foreign.service.save(saver(ALICE), foreign.document.id, query(), upload('another-unit'), HTTP_ORIGIN))).code).toBe('EDIT_LEASE_LOST')
    const stale = setup()
    stale.store.leaseRecords.clear()
    expect((await rejection(stale.service.save(saver(ALICE), stale.document.id, query({ baseRevision: 7 }), upload(stale.document.unitId), HTTP_ORIGIN))).code).toBe('EDIT_LEASE_LOST')
  })
})

describe('DocumentContentService.save：这次登录在锁下再核对一次（M3-P1 审查 A1）', () => {
  it('登录在会话守卫之后被撤销（退出、签发重置、换令牌）：401 SESSION_EXPIRED，什么也没写；在文档行的锁下查，先于能编辑与租约', async () => {
    const { store, service, document } = setup()
    store.activeSessions.delete(SESSIONS[ALICE] ?? '')
    const error = await rejection(service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN))
    expect([error.code, error.status]).toEqual(['SESSION_EXPIRED', 401])
    expect(store.documents.get(document.id)?.revision).toBe(1)
    expect(store.audits).toEqual([])
    expect(store.sessions.isActive).toHaveBeenCalledWith(SESSIONS[ALICE], expect.anything())
    expect(store.repositories.documents.lockById.mock.invocationCallOrder[0]).toBeLessThan(store.sessions.isActive.mock.invocationCallOrder[0] ?? 0)
    expect(store.leases.findByDocument).not.toHaveBeenCalled()
  })

  it('重放先于登录的核对：保存已经提交、回包丢了，之后登录被撤销，重发同一个请求拿到原来的结果（重放只要求能访问）', async () => {
    const { store, service, document } = setup()
    const request = query()
    const body = upload(document.unitId)
    const first = await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)
    store.activeSessions.delete(SESSIONS[ALICE] ?? '')
    expect(await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)).toEqual(first)
    expect(store.documents.get(document.id)?.revision).toBe(2)
  })
})
