import type { SaveContentQuery } from '@nerve-office/contracts'
import type { GzipBody } from '../security/index.ts'
import type { ContentSaver } from './document-content.service.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { canonicalContentText, contentHashInput, EDIT_LEASE_TTL_SECONDS, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentContentService, SAVE_TRANSACTION_START_WITHIN_MS, SAVE_TRANSACTION_TIMEOUT_MS } from './document-content.service.ts'
import { ALICE, BOB, BOB_SPACE, clientFormatGate, CURRENT_CLIENT, FakeStore, HTTP_ORIGIN, NO_HANDOVER, TEAM_SPACE, TRANSACTION } from './documents.test-support.ts'
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
    ...NO_HANDOVER,
  })
}

/** 保存的服务：运维开关（最低客户端构建）按用例给 */
function serviceOf(store: FakeStore, minimumBuild?: string): DocumentContentService {
  const { transactions, documents, contents, revisions, receipts, ledger, leases, sessions, policy, audit, inspector, logger } = store.deps
  return new DocumentContentService(transactions, documents, contents, revisions, receipts, ledger, leases, sessions, policy, audit, clientFormatGate(minimumBuild), inspector, logger)
}

/** 存量（P3 之前写的）内容：gzip 的快照，没有内容哈希与资源名 */
function legacyContent(snapshot: string) {
  return { snapshot: zlib.gzipSync(snapshot), rawBytes: Buffer.byteLength(snapshot), contentHash: null, resourceNames: null }
}

function setup() {
  const store = new FakeStore()
  // 两人这次的登录都有效（会话守卫放行过；保存在锁下再查一次，M3-P1 审查 A1）
  for (const session of Object.values(SESSIONS))
    store.activeSessions.add(session)
  const service = serviceOf(store)
  const document = store.addDocument({ revision: 1 })
  store.contents.set(document.id, legacyContent('{}'))
  store.addRevision({ documentId: document.id, revision: 1, kind: 'created', requestId: '0199a2c4-1f2e-4a3b-8c4d-000000000001', payloadDigest: Buffer.alloc(32), source: null, savedBy: ALICE })
  holding(store, document.id, ALICE)
  return { store, service, document }
}

/** 团队空间里的一份文档（成员按用例另加） */
function teamDocument(store: FakeStore) {
  const document = store.addDocument({ spaceId: TEAM_SPACE, revision: 1 })
  store.contents.set(document.id, legacyContent('{}'))
  return document
}

function bodyOf(text: string): GzipBody {
  const decompressed = Buffer.from(text, 'utf8')
  return { compressed: zlib.gzipSync(decompressed), decompressed }
}

/** 一份合格的快照：工作簿的结构，extra 是追加在顶层的键（让内容不同） */
function upload(unitId: string, extra = ''): GzipBody {
  return bodyOf(`{"id":"${unitId}","sheetOrder":[],"sheets":{}${extra}}`)
}

/** 带资源的快照：resources 原样写进去 */
function withResources(unitId: string, resources: readonly { name: string, data: string }[]): GzipBody {
  return bodyOf(JSON.stringify({ id: unitId, sheetOrder: [], sheets: {}, resources }))
}

/** 规范化的内容哈希（contracts 的口径，服务端用 SHA-256） */
function hashOf(body: GzipBody): Buffer {
  return createHash('sha256').update(contentHashInput(canonicalContentText(body.decompressed.toString('utf8')))).digest()
}

/** 保存的查询参数：页面上报的是现在的构建与数据格式（M3-P3） */
function query(overrides: Partial<SaveContentQuery> = {}): SaveContentQuery {
  return { baseRevision: 1, requestId: randomUUID(), clientInstanceId: CLIENT, localSeq: 5, writeEpoch: 0, ...CURRENT_CLIENT, ...overrides }
}

/** P3 之前的页面发的查询参数：没有构建、数据格式与"公式待更新" */
function oldPageQuery(overrides: Partial<SaveContentQuery> = {}): SaveContentQuery {
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
    expect(await service.read(ALICE, document.id)).toEqual({ kind: 'current', content: { revision: 1, snapshot: store.contentOf(document.id) } })
  })

  it('US-M3-05 条件请求（M3-P2 设计 §3.2，DEF-017）：当前修订在 If-None-Match 里就只回修订号、不读内容；不在里面（落后、认不出、空的列表）照常给内容；* 匹配任何现有的版本', async () => {
    const { store, service, document } = setup()
    store.documents.set(document.id, { ...document, revision: 3 })
    expect(await service.read(ALICE, document.id, [3])).toEqual({ kind: 'notModified', revision: 3 })
    expect(await service.read(ALICE, document.id, [1, 3])).toEqual({ kind: 'notModified', revision: 3 })
    expect(await service.read(ALICE, document.id, '*')).toEqual({ kind: 'notModified', revision: 3 })
    expect(store.repositories.contents.findCurrent).not.toHaveBeenCalled()
    const current = { kind: 'current', content: { revision: 3, snapshot: store.contentOf(document.id) } }
    for (const noneMatch of [[2], [], [4]])
      expect(await service.read(ALICE, document.id, noneMatch), JSON.stringify(noneMatch)).toEqual(current)
  })

  it('条件请求照样先判断权限，在只读快照里（M3-P2 设计 §3.6）：看不到的与不存在的都是 NOT_FOUND，不因为修订号对得上就回 304', async () => {
    const { store, service, document } = setup()
    expect((await rejection(service.read(BOB, document.id, [1]))).code).toBe('NOT_FOUND')
    expect((await rejection(service.read(BOB, document.id, '*'))).code).toBe('NOT_FOUND')
    expect((await rejection(service.read(ALICE, '0199a2c4-0000-7000-8000-0000000000ff', [1]))).code).toBe('NOT_FOUND')
    // 看不到与不存在执行同样的查询：两次都判断了权限（不存在的用全零的空间）
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(3)
    expect(store.transactions.readSnapshot).toHaveBeenCalledTimes(3)
    expect(store.transactions.run).not.toHaveBeenCalled()
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
  it('成功：修订号加一，换上客户端的 gzip 字节（连同规范化的哈希与非空的资源名），修订记录带来源、哈希与客户端构建，文档的信封，写审计', async () => {
    const { store, service, document } = setup()
    const body = withResources(document.unitId, [{ name: 'SHEET_NOTE_PLUGIN', data: '{"s1":{"0":{"0":{"note":"n"}}}}' }, { name: 'SHEET_FILTER_PLUGIN', data: '{}' }])
    const request = query()
    expect(await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)).toEqual({ revision: 2, savedAt: '2026-09-27T08:00:00.000Z', unchanged: false })
    expect(store.documents.get(document.id)?.revision).toBe(2)
    // 信封：SDK 版本是页面上报、核对过的（等于服务端的），客户端构建，"公式待更新"没带等于否
    expect(store.repositories.documents.advanceRevision).toHaveBeenCalledWith(document.id, 2, { sdkVersion: UNIVER_SDK_VERSION, clientBuild: '0.1.0', formulasPending: false }, expect.anything())
    expect(store.clientBuilds.get(document.id)).toBe('0.1.0')
    expect(store.contents.get(document.id)).toEqual({ snapshot: body.compressed, rawBytes: body.decompressed.length, contentHash: hashOf(body), resourceNames: ['SHEET_NOTE_PLUGIN'] })
    expect(store.revisions.at(-1)).toMatchObject({ documentId: document.id, revision: 2, kind: 'saved', requestId: request.requestId, source: { clientInstanceId: CLIENT, localSeq: 5 }, savedBy: ALICE, contentHash: hashOf(body), clientBuild: '0.1.0' })
    expect(store.revisions.at(-1)?.payloadDigest).toEqual(savedPayloadDigest(1, body.decompressed))
    expect(store.audits).toEqual([{ action: 'documents.content_saved', actor: { type: 'user', id: ALICE }, target: { type: 'document', id: document.id }, origin: HTTP_ORIGIN, details: { revision: 2 } }])
    expect(store.receipts).toEqual([])
  })

  it('US-M3-12 保存的事务限时（M3-P5 复验 C1、再复核 D1）：事务带着时限开启——BEGIN 到设下时限至多 SAVE_TRANSACTION_START_WITHIN_MS，之后至多 SAVE_TRANSACTION_TIMEOUT_MS（由数据库与事务运行器保证）；两者相加比一个有效期短，还留出至少 10 秒——撤权的"刚死不久"窗口（一个有效期）靠"保存从 BEGIN 到提交短于一个有效期"成立', async () => {
    const { store, service, document } = setup()
    await service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN)
    expect(store.transactions.run).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { limit: { timeoutMs: SAVE_TRANSACTION_TIMEOUT_MS, startWithinMs: SAVE_TRANSACTION_START_WITHIN_MS } })
    const longest = SAVE_TRANSACTION_START_WITHIN_MS + SAVE_TRANSACTION_TIMEOUT_MS
    expect(longest).toBeLessThan(EDIT_LEASE_TTL_SECONDS * 1000)
    expect(EDIT_LEASE_TTL_SECONDS * 1000 - longest).toBeGreaterThanOrEqual(10_000)
  })

  it('快照不合格：SNAPSHOT_INVALID（details 是违反的规则），不开事务（与文档无关，别人的与不存在的结果相同）；记一条 warn（规则与文档 id），不记内容', async () => {
    const { store, service, document } = setup()
    const error = await rejection(service.save(saver(ALICE), document.id, query(), bodyOf('[1]'), HTTP_ORIGIN))
    expect([error.code, error.status, error.details]).toEqual(['SNAPSHOT_INVALID', 422, { rule: 'structure' }])
    expect(store.transactions.run).not.toHaveBeenCalled()
    // 检查池按发起的账户限份数（审查 A2）：传的是保存的人
    expect(store.inspector.inspect).toHaveBeenCalledWith(expect.anything(), 'sheet@1', ALICE)
    const others = await rejection(service.save(saver(BOB), document.id, query(), bodyOf('[1]'), HTTP_ORIGIN))
    expect(store.inspector.inspect).toHaveBeenLastCalledWith(expect.anything(), 'sheet@1', BOB)
    const missing = await rejection(service.save(saver(ALICE), '0199a2c4-0000-7000-8000-0000000000ff', query(), bodyOf('[1]'), HTTP_ORIGIN))
    expect([others.details, missing.details]).toEqual([{ rule: 'structure' }, { rule: 'structure' }])
    expect(store.logs().filter(entry => entry.msg === '快照不合格，拒绝写入').map(entry => [entry.level, entry.rule, entry.documentId])).toEqual([
      ['warn', 'structure', document.id],
      ['warn', 'structure', document.id],
      ['warn', 'structure', '0199a2c4-0000-7000-8000-0000000000ff'],
    ])
    expect(store.logLines.join('')).not.toContain('[1]')
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

  it('requestId 的锁是事务的第一把锁（审查 A3）：先于判断访问与锁文档行，与新建、复制、另存为副本取锁的先后一致；看不到与不存在的同样取它', async () => {
    const { store, service, document } = setup()
    const request = query()
    await service.save(saver(ALICE), document.id, request, upload(document.unitId), HTTP_ORIGIN)
    expect(store.repositories.revisions.lockRequest).toHaveBeenCalledExactlyOnceWith(request.requestId, expect.anything())
    const lock = store.repositories.revisions.lockRequest.mock.invocationCallOrder[0] ?? Number.NaN
    const checked = store.repositories.documents.findById.mock.invocationCallOrder[0] ?? Number.NaN
    const locked = store.repositories.documents.lockById.mock.invocationCallOrder[0] ?? Number.NaN
    expect(lock).toBeLessThan(checked)
    expect(lock).toBeLessThan(locked)
    // 再查重放在锁下（锁之后）
    const rechecked = store.repositories.receipts.findByRequestId.mock.invocationCallOrder.at(-1) ?? Number.NaN
    expect(lock).toBeLessThan(rechecked)
    // 看不到的与不存在的：同样先取这把锁（与文档无关），再得到 NOT_FOUND
    store.repositories.revisions.lockRequest.mockClear()
    expect((await rejection(service.save(saver(BOB), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect((await rejection(service.save(saver(ALICE), '0199a2c4-0000-7000-8000-0000000000ff', query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.repositories.revisions.lockRequest).toHaveBeenCalledTimes(2)
  })

  it('锁下的再查在这个事务里读两张表（复验 RA14）：不在连接池上另借连接——事务已经占着一个连接，池子满时另借会与别的事务互相等待；预检在事务之外', async () => {
    const { store, service, document } = setup()
    const request = query()
    await service.save(saver(ALICE), document.id, request, upload(document.unitId), HTTP_ORIGIN)
    for (const findByRequestId of [store.repositories.revisions.findByRequestId, store.repositories.receipts.findByRequestId])
      expect(findByRequestId.mock.calls).toEqual([[request.requestId, undefined], [request.requestId, TRANSACTION]])
  })

  it('别的文档上的回执用了这个 requestId：内容不同的保存同样 REQUEST_ID_CONFLICT，不写修订记录（两张表之间也只用一次，审查 A3）', async () => {
    const { store, service, document } = setup()
    const other = store.addDocument({ revision: 1 })
    const request = query()
    store.receipts.push({ requestId: request.requestId, documentId: other.id, revision: 1, payloadDigest: Buffer.alloc(32), savedBy: ALICE, savedAt: new Date('2026-09-27T08:00:00.000Z') })
    expect((await rejection(service.save(saver(ALICE), document.id, request, upload(document.unitId, ',"z":1'), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.revisions).toHaveLength(1)
    expect(store.documents.get(document.id)?.revision).toBe(1)
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

  it('unitId 不是这份文档的：SNAPSHOT_INVALID（规则 unit-id），什么也不写', async () => {
    const { store, service, document } = setup()
    const error = await rejection(service.save(saver(ALICE), document.id, query(), upload('another-unit'), HTTP_ORIGIN))
    expect(error).toMatchObject({ code: 'SNAPSHOT_INVALID', message: '表格内容不属于这份文档', details: { rule: 'unit-id' } })
    expect(store.documents.get(document.id)?.revision).toBe(1)
  })

  it('unitId 在基准修订号之后（M3-P3 设计 §3.1）：落后的页面先得到冲突，即使它的快照的 unitId 也不对', async () => {
    const { service, document } = setup()
    expect((await rejection(service.save(saver(ALICE), document.id, query({ baseRevision: 7 }), upload('another-unit'), HTTP_ORIGIN))).code).toBe('DOCUMENT_REVISION_CONFLICT')
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

  it('当前修订是别人保存的：冲突的来源为 null（只给保存它的人本人，M3-P1 复验 C4）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.setMember(TEAM_SPACE, BOB, 'editor')
    const shared = teamDocument(store)
    store.addRevision({ documentId: shared.id, revision: 1, kind: 'created', requestId: randomUUID(), payloadDigest: Buffer.alloc(32), source: null, savedBy: ALICE })
    holding(store, shared.id, BOB)
    await service.save(saver(BOB), shared.id, query({ localSeq: 9 }), upload(shared.unitId), HTTP_ORIGIN)
    holding(store, shared.id, ALICE)
    const error = await rejection(service.save(saver(ALICE), shared.id, query({ baseRevision: 1 }), upload(shared.unitId, ',"x":1'), HTTP_ORIGIN))
    expect([error.code, error.details]).toEqual(['DOCUMENT_REVISION_CONFLICT', { currentRevision: 2, source: null }])
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

    // 预检时还没有记录（并发的同一次请求：前一方还在提交），拿到锁时已经有了：锁下的再查给出原来的结果
    store.repositories.revisions.findByRequestId.mockResolvedValueOnce(undefined)
    store.repositories.documents.lockById.mockImplementationOnce(demoteWhileWaiting)
    expect(await service.save(saver(BOB), document.id, request, body, HTTP_ORIGIN)).toEqual(first)
    expect(store.repositories.documents.lockById).toHaveBeenCalledTimes(2)
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
    store.contents.set(another.id, legacyContent('{}'))
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

  it('M3-P5 令牌是被接管的那一代的（本人在别处接手、空间管理员强制接管）：EDIT_LEASE_LOST 的详情是 taken_over 与方式，页面据此不续上、给副本；什么也没写', async () => {
    for (const [takeover, forced] of [['self', false], ['forced', true]] as const) {
      const setupResult = setup()
      const { store, document } = setupResult
      // 艾米这一代被接管：租约行换成新的一代（本人接管是艾米自己的另一个设备，强制接管是本），接管标记记着艾米手里的令牌
      const taker = takeover === 'self' ? ALICE : BOB
      holding(store, document.id, BOB, OTHER_CLIENT)
      const row = store.leaseRecords.get(document.id)
      if (row === undefined)
        throw new Error('没有摆好租约')
      store.leaseRecords.set(document.id, { ...row, holderId: taker, takenOverTokenDigest: editLeaseTokenDigest(TOKENS[ALICE] ?? ''), takeover })
      const error = await rejection(setupResult.service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN))
      expect([error.code, error.status, error.details], takeover).toEqual(['EDIT_LEASE_LOST', 409, { reason: 'taken_over', forced }])
      expect(store.documents.get(document.id)?.revision, takeover).toBe(1)
      expect(store.audits, takeover).toEqual([])
      // 别的旧令牌（不是被接管的那一代的）：replaced，详情只有原因、不带方式
      const other = await rejection(setupResult.service.save(saver(ALICE, { token: `${'c'.repeat(41)}-_` }), document.id, query(), upload(document.unitId), HTTP_ORIGIN))
      expect([other.code, other.details], takeover).toEqual(['EDIT_LEASE_LOST', { reason: 'replaced' }])
    }
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

describe('DocumentContentService.save：处理的顺序（M3-P3 设计 §3.1）——重放先于其余一切检查', () => {
  it('旧页面的重放：升级之前提交了、回包丢了，旧页面（不带构建与数据格式）原样重发，拿到原来的结果——不被拦成过旧，也不再检查快照', async () => {
    const { store, service, document } = setup()
    const request = oldPageQuery()
    const body = upload(document.unitId)
    // 升级之前的那次保存：直接摆下它的修订记录（摘要按 P3 之前的写法——没有"公式待更新"时与现在逐字节相同）
    store.addRevision({ documentId: document.id, revision: 2, kind: 'saved', requestId: request.requestId, payloadDigest: savedPayloadDigest(1, body.decompressed), source: { clientInstanceId: CLIENT, localSeq: 5 }, savedBy: ALICE })
    store.documents.set(document.id, { ...document, revision: 2 })
    expect(await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)).toEqual({ revision: 2, savedAt: '2026-09-27T08:00:00.000Z', unchanged: false })
    expect(store.inspector.inspect).not.toHaveBeenCalled()
    expect(store.transactions.run).not.toHaveBeenCalled()
    // 不是重放的同一种请求（新的 requestId）照样被拦下：过旧
    const outdated = await rejection(service.save(saver(ALICE), document.id, oldPageQuery({ baseRevision: 2 }), body, HTTP_ORIGIN))
    expect([outdated.code, outdated.status, outdated.details]).toEqual(['CLIENT_OUTDATED', 409, { reason: 'format' }])
  })

  it('规则收紧之后的重放：当初存下的内容按现在的规则不合格（例如 data: 图片），原样重发照样拿到原来的结果，不检查快照', async () => {
    const { store, service, document } = setup()
    const request = query()
    const body = bodyOf(JSON.stringify({ id: document.unitId, sheetOrder: [], sheets: {}, resources: [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ s1: { data: { d1: { source: 'data:image/png;base64,AAAA' } }, order: [] } }) }] }))
    store.addRevision({ documentId: document.id, revision: 2, kind: 'saved', requestId: request.requestId, payloadDigest: savedPayloadDigest(1, body.decompressed), source: { clientInstanceId: CLIENT, localSeq: 5 }, savedBy: ALICE })
    store.documents.set(document.id, { ...document, revision: 2 })
    expect(await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)).toMatchObject({ revision: 2, unchanged: false })
    expect(store.inspector.inspect).not.toHaveBeenCalled()
    // 不是重放（新的 requestId）：按现在的规则被拒
    expect((await rejection(service.save(saver(ALICE), document.id, query({ baseRevision: 2 }), body, HTTP_ORIGIN))).details).toEqual({ rule: 'image-source' })
  })

  it('回执的重放同样先于一切检查：内容相同的那次确认结果未知，之后升级了（旧页面不带构建与数据格式）、规则也收紧了，原样重发拿到原来的确认（unchanged），不被拦成过旧、不检查快照、不开事务', async () => {
    const { store, service, document } = setup()
    const request = oldPageQuery()
    // 内容按现在的规则不合格（data: 图片）：只有重放能让它拿到结果
    const body = bodyOf(JSON.stringify({ id: document.unitId, sheetOrder: [], sheets: {}, resources: [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ s1: { data: { d1: { source: 'data:image/png;base64,AAAA' } }, order: [] } }) }] }))
    // 升级之前的那次确认：直接摆下它的回执（摘要按 P3 之前的写法——没有"公式待更新"时与现在逐字节相同）
    const savedAt = new Date('2026-09-26T08:00:00.000Z')
    store.receipts.push({ requestId: request.requestId, documentId: document.id, revision: 1, payloadDigest: savedPayloadDigest(1, body.decompressed), savedBy: ALICE, savedAt })
    expect(await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)).toEqual({ revision: 1, savedAt: savedAt.toISOString(), unchanged: true })
    expect(store.inspector.inspect).not.toHaveBeenCalled()
    expect(store.transactions.run).not.toHaveBeenCalled()
    expect(store.receipts).toHaveLength(1)
    // 现在的页面原样重发同样是重放（不检查快照）；不是重放的（新的 requestId）照样被拦下：旧页面过旧，现在的页面快照不合格
    expect(await service.save(saver(ALICE), document.id, { ...query(), requestId: request.requestId }, body, HTTP_ORIGIN)).toMatchObject({ revision: 1, unchanged: true })
    expect(store.inspector.inspect).not.toHaveBeenCalled()
    expect((await rejection(service.save(saver(ALICE), document.id, oldPageQuery(), body, HTTP_ORIGIN))).details).toEqual({ reason: 'format' })
    expect((await rejection(service.save(saver(ALICE), document.id, query(), body, HTTP_ORIGIN))).details).toEqual({ rule: 'image-source' })
  })

  it('预检不提前回答：requestId 用过却不是这一次（别人的、另一份文档的、内容不同的）、看不到了，都往下走——由事务里的再查给出 REQUEST_ID_CONFLICT 或 NOT_FOUND', async () => {
    const { store, service, document } = setup()
    const request = query()
    await service.save(saver(ALICE), document.id, request, upload(document.unitId), HTTP_ORIGIN)
    store.inspector.inspect.mockClear()
    // 内容不同：预检没有结论，照常检查快照，事务里是 REQUEST_ID_CONFLICT
    expect((await rejection(service.save(saver(ALICE), document.id, { ...request, baseRevision: 2 }, upload(document.unitId, ',"z":1'), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.inspector.inspect).toHaveBeenCalledTimes(1)
  })

  it('格式拦截在快照检查之前、事务之前：过旧的页面带着不合格的快照得到的是 CLIENT_OUTDATED（先说需要刷新），不检查快照、不开事务', async () => {
    const { store, service, document } = setup()
    for (const [format, reason] of [
      [{ univerVersion: '0.9.0' }, 'format'],
      [{ profile: 'sheet@2' }, 'format'],
      [{ formatVersion: 2 }, 'format'],
      [{ clientBuild: undefined }, 'build'],
    ] as const) {
      const error = await rejection(service.save(saver(ALICE), document.id, query(format), bodyOf('[1]'), HTTP_ORIGIN))
      expect([error.code, error.details], JSON.stringify(format)).toEqual(['CLIENT_OUTDATED', { reason }])
    }
    expect(store.inspector.inspect).not.toHaveBeenCalled()
    expect(store.transactions.run).not.toHaveBeenCalled()
  })

  it('运维开关（NERVE_MIN_CLIENT_BUILD）：构建低于它 → CLIENT_OUTDATED（build）；不低于它照常保存', async () => {
    const { store, document } = setup()
    const service = serviceOf(store, '0.2.0')
    expect((await rejection(service.save(saver(ALICE), document.id, query({ clientBuild: '0.1.9' }), upload(document.unitId), HTTP_ORIGIN))).details).toEqual({ reason: 'build' })
    expect(await service.save(saver(ALICE), document.id, query({ clientBuild: '0.2.0+0123abc' }), upload(document.unitId), HTTP_ORIGIN)).toMatchObject({ revision: 2 })
    expect(store.clientBuilds.get(document.id)).toBe('0.2.0+0123abc')
  })

  it('文档由比服务端新的版本写过（回滚之后）：DOCUMENT_TOO_NEW，在登录的核对之后、能编辑与租约之前，什么也不写', async () => {
    const { store, service, document } = setup()
    store.documents.set(document.id, { ...document, sdkVersion: '99.0.0' })
    const error = await rejection(service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN))
    expect([error.code, error.status]).toEqual(['DOCUMENT_TOO_NEW', 409])
    expect(store.leases.findByDocument).not.toHaveBeenCalled()
    expect(store.revisions).toHaveLength(1)
    // 看不到的照样 404：不透露它比服务端新
    expect((await rejection(service.save(saver(BOB), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
  })
})

describe('DocumentContentService.save：不缩水（00 号计划书 §8.2，M3-P3 设计 §3.3）', () => {
  const NOTE = { name: 'SHEET_NOTE_PLUGIN', data: '{"s1":{"0":{"0":{"note":"n"}}}}' }

  it('上一版非空的资源这一版不在了：SNAPSHOT_INVALID（resource-missing），记 warn（缺了哪些）；变空不算缩水', async () => {
    const { store, service, document } = setup()
    await service.save(saver(ALICE), document.id, query(), withResources(document.unitId, [NOTE]), HTTP_ORIGIN)
    expect(store.contents.get(document.id)?.resourceNames).toEqual(['SHEET_NOTE_PLUGIN'])
    const error = await rejection(service.save(saver(ALICE), document.id, query({ baseRevision: 2 }), upload(document.unitId), HTTP_ORIGIN))
    expect([error.code, error.details]).toEqual(['SNAPSHOT_INVALID', { rule: 'resource-missing' }])
    expect(store.logs().find(entry => entry.rule === 'resource-missing')).toMatchObject({ level: 'warn', documentId: document.id, missing: ['SHEET_NOTE_PLUGIN'] })
    expect(store.documents.get(document.id)?.revision).toBe(2)
    // 在、但删光了（变空）：照常保存，这一版之后没有非空的资源
    expect(await service.save(saver(ALICE), document.id, query({ baseRevision: 2 }), withResources(document.unitId, [{ name: 'SHEET_NOTE_PLUGIN', data: '{"s1":{}}' }]), HTTP_ORIGIN)).toMatchObject({ revision: 3 })
    expect(store.contents.get(document.id)?.resourceNames).toEqual([])
  })

  it('存量（资源名为空）：解析上一版得到非空的资源；白名单之外的（例如 M1 去掉的 AuthzIoMock）不算缩水', async () => {
    const { store, service, document } = setup()
    store.contents.set(document.id, legacyContent(JSON.stringify({ id: document.unitId, resources: [NOTE, { name: 'SHEET_AuthzIoMockService_PLUGIN', data: '{"x":1}' }, { name: 'SHEET_FILTER_PLUGIN', data: '' }] })))
    expect((await rejection(service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN))).details).toEqual({ rule: 'resource-missing' })
    expect(await service.save(saver(ALICE), document.id, query(), withResources(document.unitId, [NOTE]), HTTP_ORIGIN)).toMatchObject({ revision: 2 })
  })

  it('存量解析不出来（坏了的内容）：没有可核对的上一版，记一条 warn，照常保存', async () => {
    const { store, service, document } = setup()
    store.contents.set(document.id, { ...legacyContent('x'), snapshot: Buffer.from('不是 gzip') })
    expect(await service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN)).toMatchObject({ revision: 2 })
    expect(store.logs().find(entry => entry.msg === '存量的快照解析不出资源，这一次保存不核对不缩水')).toMatchObject({ level: 'warn', documentId: document.id })
  })
})

describe('DocumentContentService.save：内容相同不递增与回执（M3-P3 设计 §3.7）', () => {
  it('内容与当前相同：修订号不变（给出当前修订与它的时间，unchanged），不写内容、修订记录与审计，写一条回执', async () => {
    const { store, service, document } = setup()
    const body = upload(document.unitId)
    await service.save(saver(ALICE), document.id, query(), body, HTTP_ORIGIN)
    const stored = store.contents.get(document.id)
    const request = query({ baseRevision: 2 })
    expect(await service.save(saver(ALICE), document.id, request, upload(document.unitId), HTTP_ORIGIN)).toEqual({ revision: 2, savedAt: '2026-09-27T08:00:00.000Z', unchanged: true })
    expect(store.documents.get(document.id)?.revision).toBe(2)
    expect(store.contents.get(document.id)).toBe(stored)
    expect(store.revisions).toHaveLength(2)
    expect(store.audits).toHaveLength(1)
    expect(store.receipts).toEqual([{ requestId: request.requestId, documentId: document.id, revision: 2, payloadDigest: savedPayloadDigest(2, body.decompressed), savedBy: ALICE, savedAt: new Date('2026-09-27T08:00:00.000Z') }])
  })

  it('只改了视图状态（缩放、滚动）也算相同；存量（哈希为空）按不同处理，第一次保存多一个修订', async () => {
    const { store, service, document } = setup()
    expect(store.contents.get(document.id)?.contentHash).toBeNull()
    const sheet = (zoomRatio: number) => bodyOf(JSON.stringify({ id: document.unitId, sheetOrder: ['s1'], sheets: { s1: { id: 's1', zoomRatio, scrollTop: zoomRatio * 10 } } }))
    expect(await service.save(saver(ALICE), document.id, query(), sheet(1), HTTP_ORIGIN)).toMatchObject({ revision: 2, unchanged: false })
    expect(await service.save(saver(ALICE), document.id, query({ baseRevision: 2 }), sheet(2), HTTP_ORIGIN)).toMatchObject({ revision: 2, unchanged: true })
  })

  it('内容相同仍要过全部检查：基准过时是冲突、编辑权失效是 EDIT_LEASE_LOST（access.spec 的情形），都在比较内容之前', async () => {
    const { store, service, document } = setup()
    await service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN)
    expect((await rejection(service.save(saver(ALICE), document.id, query({ baseRevision: 1 }), upload(document.unitId), HTTP_ORIGIN))).code).toBe('DOCUMENT_REVISION_CONFLICT')
    store.leaseRecords.clear()
    expect((await rejection(service.save(saver(ALICE), document.id, query({ baseRevision: 2 }), upload(document.unitId), HTTP_ORIGIN))).code).toBe('EDIT_LEASE_LOST')
    expect(store.receipts).toEqual([])
  })

  it('回执的重放：内容相同的那次保存结果未知，之后编辑权到期、被别人接手、登录被撤销，原样重发照样拿到原来的确认（unchanged），不再写回执', async () => {
    const { store, service, document } = setup()
    await service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN)
    const request = query({ baseRevision: 2 })
    const first = await service.save(saver(ALICE), document.id, request, upload(document.unitId), HTTP_ORIGIN)
    store.databaseNow = new Date(store.databaseNow.getTime() + EDIT_LEASE_TTL_SECONDS * 1000)
    holding(store, document.id, BOB)
    store.activeSessions.delete(SESSIONS[ALICE] ?? '')
    expect(await service.save(saver(ALICE), document.id, request, upload(document.unitId), HTTP_ORIGIN)).toEqual(first)
    expect(store.receipts).toHaveLength(1)
    // 同一个 requestId、内容不同：不是那一次，REQUEST_ID_CONFLICT
    store.activeSessions.add(SESSIONS[ALICE] ?? '')
    holding(store, document.id, ALICE)
    expect((await rejection(service.save(saver(ALICE), document.id, request, upload(document.unitId, ',"z":1'), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('回执的 requestId 刚被别处用掉：REQUEST_ID_CONFLICT，标记不改', async () => {
    const { store, service, document } = setup()
    await service.save(saver(ALICE), document.id, query({ formulasPending: true }), upload(document.unitId), HTTP_ORIGIN)
    store.repositories.receipts.insert.mockResolvedValueOnce(undefined)
    // 收齐之后的再保存本该清掉标记：回执没写成，标记照旧
    expect((await rejection(service.save(saver(ALICE), document.id, query({ baseRevision: 2 }), upload(document.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.repositories.documents.setFormulasPending).not.toHaveBeenCalled()
    expect(store.documents.get(document.id)?.formulasPending).toBe(true)
  })
})

describe('DocumentContentService.save："公式待更新"（M3-P3 设计 §3.8）', () => {
  it('写入时设成请求里的值；内容相同、修订号不变时照样清掉（收齐之后的再保存）', async () => {
    const { store, service, document } = setup()
    await service.save(saver(ALICE), document.id, query({ formulasPending: true }), upload(document.unitId), HTTP_ORIGIN)
    expect(store.documents.get(document.id)?.formulasPending).toBe(true)
    // 内容相同、这次也没收齐：留着
    expect(await service.save(saver(ALICE), document.id, query({ baseRevision: 2, formulasPending: true }), upload(document.unitId), HTTP_ORIGIN)).toMatchObject({ revision: 2, unchanged: true })
    expect(store.repositories.documents.setFormulasPending).not.toHaveBeenCalled()
    expect(await service.save(saver(ALICE), document.id, query({ baseRevision: 2, formulasPending: false }), upload(document.unitId), HTTP_ORIGIN)).toMatchObject({ revision: 2, unchanged: true })
    expect(store.documents.get(document.id)?.formulasPending).toBe(false)
    expect(store.repositories.documents.setFormulasPending).toHaveBeenCalledTimes(1)
    // 标记没变时不改
    await service.save(saver(ALICE), document.id, query({ baseRevision: 2 }), upload(document.unitId), HTTP_ORIGIN)
    expect(store.repositories.documents.setFormulasPending).toHaveBeenCalledTimes(1)
  })

  it('内容相同时只清不设（审查 A6）：库里已经收齐，这次捕获没等到收齐（标记为真）——内容相同就是公式的结果相同，这份就是收齐的那一版，标记不变；回执照写', async () => {
    const { store, service, document } = setup()
    await service.save(saver(ALICE), document.id, query(), upload(document.unitId), HTTP_ORIGIN)
    expect(store.documents.get(document.id)?.formulasPending).toBe(false)
    const request = query({ baseRevision: 2, formulasPending: true })
    expect(await service.save(saver(ALICE), document.id, request, upload(document.unitId), HTTP_ORIGIN)).toMatchObject({ revision: 2, unchanged: true })
    expect(store.documents.get(document.id)?.formulasPending).toBe(false)
    expect(store.repositories.documents.setFormulasPending).not.toHaveBeenCalled()
    expect(store.receipts.map(receipt => receipt.requestId)).toEqual([request.requestId])
    // 内容变了的写入照样按请求设上
    expect(await service.save(saver(ALICE), document.id, query({ baseRevision: 2, formulasPending: true }), upload(document.unitId, ',"z":1'), HTTP_ORIGIN)).toMatchObject({ revision: 3, unchanged: false })
    expect(store.documents.get(document.id)?.formulasPending).toBe(true)
  })

  it('计入负载摘要：同一个 requestId 而标记不同，是另一个请求（REQUEST_ID_CONFLICT）；不带标记等于否', async () => {
    const { store, service, document } = setup()
    const request = query({ formulasPending: true })
    const body = upload(document.unitId)
    const first = await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)
    expect(store.revisions.at(-1)?.payloadDigest).toEqual(savedPayloadDigest(1, body.decompressed, true))
    expect(await service.save(saver(ALICE), document.id, request, body, HTTP_ORIGIN)).toEqual(first)
    expect((await rejection(service.save(saver(ALICE), document.id, { ...request, formulasPending: false }, body, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    const plain = query({ baseRevision: 2 })
    await service.save(saver(ALICE), document.id, plain, upload(document.unitId, ',"a":1'), HTTP_ORIGIN)
    expect(await service.save(saver(ALICE), document.id, { ...plain, formulasPending: false }, upload(document.unitId, ',"a":1'), HTTP_ORIGIN)).toMatchObject({ revision: 3 })
  })
})
