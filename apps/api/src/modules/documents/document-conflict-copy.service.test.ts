// 另存为副本（M3-P2 设计 §3.2，00 号计划书 §7.5）：只要求能读原文档、放在哪里（锁下决定）、unitId、新文档的各列、不带授权、
// requestId 的幂等与取锁的顺序。真实的 SQL、HTTP 的正文读取与确定交错的锁由集成测试覆盖（documents/conflict-copies.test.ts），
// 这里的假仓储只保持同样的语义。
import type { ConflictCopyQuery } from '@nerve-office/contracts'
import type { GzipBody } from '../security/index.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { canonicalContentText, contentHashInput, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { documentTooNew } from './client-format-gate.ts'
import { DocumentConflictCopyService } from './document-conflict-copy.service.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, CURRENT_CLIENT, FakeStore, HTTP_ORIGIN, member, TEAM_SPACE } from './documents.test-support.ts'
import { conflictCopyPayloadDigest } from './payload-digest.ts'

const MISSING_ID = '0199a2c4-0000-7000-8000-0000000000fd'
const TITLE = '周报（冲突副本 2026-10-04 14:30）'

function setup() {
  const store = new FakeStore()
  const { transactions, documents, contents, revisions, ledger, folders, tree, spaces, policy, audit, clientFormats, inspector, logger } = store.deps
  return { store, service: new DocumentConflictCopyService(transactions, documents, contents, revisions, ledger, folders, tree, spaces, policy, audit, clientFormats, inspector, logger) }
}

let requests = 0
function nextRequestId(): string {
  requests += 1
  return `0199a2c4-0000-7000-8000-${String(requests).padStart(12, '0')}`
}

/** 另存为副本的查询参数：新的 requestId、标题，页面上报的是现在的构建与数据格式（M3-P3） */
function copyCommand(overrides: Partial<ConflictCopyQuery> = {}): ConflictCopyQuery {
  return { requestId: nextRequestId(), title: TITLE, ...CURRENT_CLIENT, ...overrides }
}

/** 团队空间里的一份原文档（可以放在文件夹里）；艾米在团队空间的角色由用例给出 */
function teamSource(store: FakeStore, options: { folderId?: string } = {}) {
  const document = store.addDocument({ spaceId: TEAM_SPACE, createdBy: BOB, title: '周报', ...(options.folderId === undefined ? {} : { folderId: options.folderId }) })
  store.contents.set(document.id, { snapshot: zlib.gzipSync('{}'), rawBytes: 2, contentHash: null, resourceNames: null })
  return document
}

/** 规范化的内容哈希（contracts 的口径） */
function hashOf(body: GzipBody): Buffer {
  return createHash('sha256').update(contentHashInput(canonicalContentText(body.decompressed.toString('utf8')))).digest()
}

/** 本页捕获的快照（顶层 id 默认是原文档的 unitId），上传的是它的 gzip */
function upload(unitId: string, value = '本页的修改'): GzipBody {
  const decompressed = Buffer.from(JSON.stringify({ id: unitId, sheetOrder: ['s1'], sheets: { s1: { cellData: { 0: { 0: { v: value } } } } } }), 'utf8')
  return { compressed: zlib.gzipSync(decompressed), decompressed }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error(`期望抛出 AppError，实际是 ${String(error)}`)
  return error
}

describe('DocumentConflictCopyService.copy：新文档', () => {
  it('US-M3-11 能在原文档所在的空间新建：放进原文档所在的文件夹；新的 id、修订号 1、代次 0，unitId 与原文档相同，内容是上传的字节，修订记录 created，审计与响应', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    // 原文档有过几代编辑权（代次不为 0）：副本是新的文档，代次从 0 开始
    const source = teamSource(store, { folderId: folder.id })
    store.documents.set(source.id, { ...source, writeEpoch: 5, revision: 7 })
    const body = upload(source.unitId)
    const requestId = nextRequestId()
    const copy = await service.copy(member(ALICE), source.id, copyCommand({ requestId }), body, HTTP_ORIGIN)

    expect(copy.id).not.toBe(source.id)
    expect(copy).toMatchObject({ title: TITLE, spaceId: TEAM_SPACE, folderId: folder.id, revision: 1, type: 'sheet', profile: 'sheet@1', formatVersion: 1, accessVia: 'space', replayed: false })
    expect(copy.permissions).toMatchObject({ canEdit: true, canRename: true })
    const stored = store.documents.get(copy.id)
    expect(stored).toMatchObject({ unitId: source.unitId, writeEpoch: 0, createdBy: ALICE, revision: 1 })
    // 类型与 unitId 照原文档（INSERT … SELECT），信封是这次上传的、核对过的页面的（M3-P3，审查 A7）：档案、格式版本、SDK 版本、客户端构建，"公式待更新"
    expect(store.repositories.documents.copyFrom).toHaveBeenCalledExactlyOnceWith(source.id, {
      spaceId: TEAM_SPACE,
      folderId: folder.id,
      title: TITLE,
      createdBy: ALICE,
      envelope: { profile: 'sheet@1', formatVersion: 1, sdkVersion: UNIVER_SDK_VERSION, clientBuild: '0.1.0', formulasPending: false },
    }, expect.anything())
    // 内容是上传的压缩字节（原样存下，与保存一样），解压前的字节数，连同规范化的哈希与非空的资源名（没有资源）
    expect(store.contents.get(copy.id)).toEqual({ snapshot: body.compressed, rawBytes: body.decompressed.length, contentHash: hashOf(body), resourceNames: [] })
    expect(store.revisions.filter(row => row.documentId === copy.id)).toEqual([expect.objectContaining({
      revision: 1,
      kind: 'created',
      requestId,
      source: null,
      savedBy: ALICE,
      payloadDigest: conflictCopyPayloadDigest(source.id, TITLE, body.decompressed),
      contentHash: hashOf(body),
      clientBuild: '0.1.0',
    })])
    // 原文档一点不动
    expect(store.documents.get(source.id)).toMatchObject({ revision: 7, writeEpoch: 5 })
    expect(store.revisions.filter(row => row.documentId === source.id)).toEqual([])
    expect(store.audits).toEqual([{
      action: 'documents.conflict_copied',
      actor: { type: 'user', id: ALICE },
      target: { type: 'document', id: copy.id },
      origin: HTTP_ORIGIN,
      details: { sourceId: source.id, spaceId: TEAM_SPACE },
    }])
  })

  it('原文档由更新的版本写过（回滚之后：档案、格式版本、SDK 版本都比服务端新）：副本的信封是本页的（核对过、等于服务端的），不照抄原文档——副本不是"比服务端新"（审查 A7）', async () => {
    const { store, service } = setup()
    const source = store.addDocument({ spaceId: ALICE_SPACE, profile: 'sheet@2' as 'sheet@1', formatVersion: 2, sdkVersion: '99.0.0', formulasPending: true })
    const copy = await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect(copy).toMatchObject({ profile: 'sheet@1', formatVersion: 1, sdkVersion: UNIVER_SDK_VERSION, formulasPending: false })
    expect(store.documents.get(copy.id)).toMatchObject({ type: 'sheet', unitId: source.unitId, profile: 'sheet@1', formatVersion: 1, sdkVersion: UNIVER_SDK_VERSION, formulasPending: false })
    expect(documentTooNew(store.documents.get(copy.id) ?? source)).toBe(false)
    // 原文档不动
    expect(store.documents.get(source.id)).toMatchObject({ profile: 'sheet@2', formatVersion: 2, sdkVersion: '99.0.0' })
  })

  it('原文档在空间的根目录：副本也在根目录', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    const source = teamSource(store)
    const copy = await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect([copy.spaceId, copy.folderId]).toEqual([TEAM_SPACE, null])
  })

  it('原文档自己的个人空间里：放进它所在的文件夹', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '草稿' })
    const source = store.addDocument({ spaceId: ALICE_SPACE, folderId: folder.id })
    const copy = await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect([copy.spaceId, copy.folderId]).toEqual([ALICE_SPACE, folder.id])
    expect(store.spaces.holdSpace.mock.calls.map(call => call[0])).toEqual([ALICE_SPACE])
  })

  it('原文档所在的文件夹不在了（防御：正常状态的文档不会挂在不在的文件夹下）：放进空间的根目录', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const source = teamSource(store, { folderId: folder.id })
    store.repositories.folders.findById.mockResolvedValueOnce(undefined)
    const copy = await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect([copy.spaceId, copy.folderId]).toEqual([TEAM_SPACE, null])
  })

  it.each([
    ['空间里的查看者', (store: FakeStore) => store.setMember(TEAM_SPACE, ALICE, 'viewer')],
    ['归档的空间里的编辑者', (store: FakeStore) => {
      store.setMember(TEAM_SPACE, ALICE, 'editor')
      store.space(TEAM_SPACE).status = 'archived'
    }],
    ['全员可见的空间里不是成员的人', (store: FakeStore) => {
      store.space(TEAM_SPACE).visibleToAll = true
    }],
  ])('US-M3-12 能读、不能在原文档所在的空间新建（%s）：放进本人个人空间的根目录', async (_name, arrange) => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const source = teamSource(store, { folderId: folder.id })
    arrange(store)
    const copy = await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect(copy).toMatchObject({ spaceId: ALICE_SPACE, folderId: null, space: { id: ALICE_SPACE, type: 'personal' }, accessVia: 'space', permissions: { canEdit: true, canShare: true } })
    expect(store.audits.at(-1)?.details).toEqual({ sourceId: source.id, spaceId: ALICE_SPACE })
    // 不放进原文档所在的空间就不取它的树锁
    expect(store.treeLocks).toEqual([])
  })

  it.each([['查看', 'viewer'], ['编辑', 'editor']] as const)('只凭%s授权的人：能读就行，放进个人空间；副本不带原文档的授权（M2-P5 复制的同一条）', async (_name, role) => {
    const { store, service } = setup()
    const source = teamSource(store)
    store.setGrant(source.id, ALICE, role)
    store.setGrant(source.id, BOB, 'editor', ALICE)
    const copy = await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect([copy.spaceId, copy.folderId, copy.accessVia]).toEqual([ALICE_SPACE, null, 'space'])
    expect([...store.grantRecords.values()].filter(grant => grant.documentId === copy.id)).toEqual([])
    // 别人（原文档上的被授权人）看不到副本
    expect(await store.policy.accessOf(BOB, { id: copy.id, spaceId: copy.spaceId, createdBy: ALICE })).toBeUndefined()
  })
})

describe('DocumentConflictCopyService.copy：拒绝', () => {
  it('US-M3-12 读不到原文档（看不到、不存在）：同一个 NOT_FOUND，不取任何锁，什么也不写', async () => {
    const { store, service } = setup()
    const source = store.addDocument({ spaceId: BOB_SPACE, createdBy: BOB })
    const hidden = await errorOf(service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN))
    const missing = await errorOf(service.copy(member(ALICE), MISSING_ID, copyCommand(), upload(source.unitId), HTTP_ORIGIN))
    expect([hidden.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(hidden.message).toBe(missing.message)
    // 不存在的也判断了一次权限（全零的空间）：两次都查了空间事实
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(2)
    expect(store.treeLocks).toEqual([])
    expect(store.spaces.holdSpace).not.toHaveBeenCalled()
    expect(store.repositories.documents.holdById).not.toHaveBeenCalled()
    expect(store.documents.size).toBe(1)
    expect(store.audits).toEqual([])
  })

  it('快照的顶层 id 不是原文档的 unitId：SNAPSHOT_INVALID，不取锁、什么也不写', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    const error = await errorOf(service.copy(member(ALICE), source.id, copyCommand(), upload('unit-of-another-document'), HTTP_ORIGIN))
    expect([error.code, error.message, error.details]).toEqual(['SNAPSHOT_INVALID', '表格内容不属于这份文档', { rule: 'unit-id' }])
    expect(store.treeLocks).toEqual([])
    expect(store.spaces.holdSpace).not.toHaveBeenCalled()
    expect(store.documents.size).toBe(1)
  })

  it('快照不合格（完整的检查，与保存相同，M3-P3）：SNAPSHOT_INVALID（details 是违反的规则），在事务之前，不开事务；记 warn', async () => {
    const { store, service } = setup()
    const source = teamSource(store)
    const decompressed = Buffer.from('[]', 'utf8')
    const error = await errorOf(service.copy(member(ALICE), source.id, copyCommand(), { compressed: zlib.gzipSync(decompressed), decompressed }, HTTP_ORIGIN))
    expect([error.code, error.details]).toEqual(['SNAPSHOT_INVALID', { rule: 'structure' }])
    expect(store.transactions.run).not.toHaveBeenCalled()
    // 资源、图片与链接的规则同样适用：例如非平台的图片地址
    const image = Buffer.from(JSON.stringify({ id: source.unitId, sheetOrder: [], sheets: { s1: { cellData: { 0: { 0: { p: { drawings: { d: { source: 'https://example.com/a.png' } } } } } } } } }), 'utf8')
    expect((await errorOf(service.copy(member(ALICE), source.id, copyCommand(), { compressed: zlib.gzipSync(image), decompressed: image }, HTTP_ORIGIN))).details).toEqual({ rule: 'image-source' })
    expect(store.logs().filter(entry => entry.msg === '快照不合格，拒绝写入').map(entry => [entry.level, entry.rule, entry.documentId])).toEqual([['warn', 'structure', source.id], ['warn', 'image-source', source.id]])
  })

  it('页面过旧（M3-P3 设计 §3.5）：CLIENT_OUTDATED（details.reason），在快照检查与事务之前；别人的与不存在的文档同样', async () => {
    const { store, service } = setup()
    const source = teamSource(store)
    for (const [overrides, reason] of [[{ univerVersion: '0.9.0' }, 'format'], [{ clientBuild: undefined }, 'build']] as const) {
      for (const target of [source.id, MISSING_ID]) {
        const error = await errorOf(service.copy(member(ALICE), target, copyCommand(overrides), upload(source.unitId), HTTP_ORIGIN))
        expect([error.code, error.details]).toEqual(['CLIENT_OUTDATED', { reason }])
      }
    }
    expect(store.inspector.inspect).not.toHaveBeenCalled()
    expect(store.transactions.run).not.toHaveBeenCalled()
  })

  it('锁住的原文档建不出副本：原文档行在共享锁下，这是数据不一致，抛 Error（500）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    store.repositories.documents.copyFrom.mockResolvedValueOnce(undefined)
    await expect(service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)).rejects.toThrow(`锁住的原文档建不出副本：${source.id}`)
  })

  it('写修订记录时 requestId 刚被一次保存用掉：REQUEST_ID_CONFLICT', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    store.repositories.revisions.insert.mockResolvedValueOnce(undefined)
    expect((await errorOf(service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.audits).toEqual([])
  })
})

describe('DocumentConflictCopyService.copy：锁与锁下的判断', () => {
  it('取锁的顺序：requestId 的锁 → 原文档所在空间的树锁 → 两个空间行（按 id）→ 原文档行（共享锁）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect(store.treeLocks).toEqual([[TEAM_SPACE]])
    expect(store.spaces.holdSpace.mock.calls.map(call => call[0])).toEqual([ALICE_SPACE, TEAM_SPACE].toSorted())
    const request = store.repositories.revisions.lockRequest.mock.invocationCallOrder[0] ?? 0
    const tree = store.tree.lock.mock.invocationCallOrder[0] ?? 0
    const spaceRows = store.spaces.holdSpace.mock.invocationCallOrder
    const sourceRow = store.repositories.documents.holdById.mock.invocationCallOrder
    expect(request).toBeLessThan(tree)
    expect(tree).toBeLessThan(spaceRows[0] ?? 0)
    expect(sourceRow).toHaveLength(1)
    expect(spaceRows.at(-1) ?? 0).toBeLessThan(sourceRow[0] ?? 0)
    // 共享锁，不是保存用的 FOR UPDATE
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
    expect(sourceRow[0] ?? 0).toBeLessThan(store.repositories.documents.copyFrom.mock.invocationCallOrder[0] ?? 0)
  })

  it('取锁之前能新建、取空间行的锁之前被降为查看者：锁下重新决定，放进个人空间', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    store.spaces.holdSpace.mockImplementation(async (spaceId: string) => {
      if (spaceId === TEAM_SPACE)
        store.setMember(TEAM_SPACE, ALICE, 'viewer')
      return undefined
    })
    const copy = await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect([copy.spaceId, copy.folderId]).toEqual([ALICE_SPACE, null])
  })

  it('取锁之前不能新建、锁下被升为编辑者：照旧放进个人空间（那个空间的树锁没有取，放进它的文件夹不安全）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const source = teamSource(store, { folderId: folder.id })
    store.spaces.holdSpace.mockImplementation(async (spaceId: string) => {
      if (spaceId === TEAM_SPACE)
        store.setMember(TEAM_SPACE, ALICE, 'editor')
      return undefined
    })
    const copy = await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect([copy.spaceId, copy.folderId]).toEqual([ALICE_SPACE, null])
    expect(store.treeLocks).toEqual([])
  })

  it('判断过能读之后、取锁之前被移出空间：锁下重新判断，NOT_FOUND，什么也不写', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    const source = teamSource(store)
    store.spaces.holdSpace.mockImplementation(async (spaceId: string) => {
      if (spaceId === TEAM_SPACE)
        store.setMember(TEAM_SPACE, ALICE, undefined)
      return undefined
    })
    const error = await errorOf(service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN))
    expect(error.code).toBe('NOT_FOUND')
    expect(store.repositories.documents.copyFrom).not.toHaveBeenCalled()
    expect(store.audits).toEqual([])
  })

  it('锁下读到的原文档换了文件夹（取树锁之前在空间内移动过）：放进它现在所在的文件夹', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const before = store.addFolder({ spaceId: TEAM_SPACE, name: '原来的' })
    const after = store.addFolder({ spaceId: TEAM_SPACE, name: '现在的' })
    const source = teamSource(store, { folderId: before.id })
    store.repositories.documents.holdById.mockImplementationOnce(async () => ({ ...source, folderId: after.id }))
    const copy = await service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN)
    expect(copy.folderId).toBe(after.id)
  })

  it('判断之后、取锁之前原文档被移到了别的空间（仍然读得到）：锁保护不到它，NOT_FOUND（与复制相同）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    store.repositories.documents.holdById.mockImplementationOnce(async () => ({ ...source, spaceId: ALICE_SPACE }))
    expect((await errorOf(service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.repositories.documents.copyFrom).not.toHaveBeenCalled()
  })

  it('等锁期间原文档进了回收站或被永久删除：NOT_FOUND', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    store.repositories.documents.holdById.mockResolvedValueOnce(undefined)
    expect((await errorOf(service.copy(member(ALICE), source.id, copyCommand(), upload(source.unitId), HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.repositories.documents.copyFrom).not.toHaveBeenCalled()
  })
})

describe('DocumentConflictCopyService.copy：requestId 幂等（与新建、复制同一个做法）', () => {
  it('US-M3-13 同一个请求重发：返回同一份副本现在的样子、replayed 为真，不再建、不再记审计；重放先于其余检查', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    const command = copyCommand()
    const first = await service.copy(member(ALICE), source.id, command, upload(source.unitId), HTTP_ORIGIN)
    // 重新压缩的字节不同、解压后相同：同一个请求
    const again = upload(source.unitId)
    const recompressed = { compressed: zlib.gzipSync(again.decompressed, { level: 1 }), decompressed: again.decompressed }
    expect(recompressed.compressed.equals(again.compressed)).toBe(false)
    expect(await service.copy(member(ALICE), source.id, command, recompressed, HTTP_ORIGIN)).toEqual({ ...first, replayed: true })
    expect(store.documents.size).toBe(2)
    expect(store.audits).toHaveLength(1)
  })

  it('结果未知之后被降为查看者（这次本该放进个人空间）：放在哪里不算进摘要，重发照样是重放，返回原来那一份', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    const command = copyCommand()
    const first = await service.copy(member(ALICE), source.id, command, upload(source.unitId), HTTP_ORIGIN)
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    const replayed = await service.copy(member(ALICE), source.id, command, upload(source.unitId), HTTP_ORIGIN)
    expect([replayed.id, replayed.spaceId, replayed.replayed]).toEqual([first.id, TEAM_SPACE, true])
    // 权限按现在的算：副本在团队空间里，她现在是查看者
    expect(replayed.permissions.canEdit).toBe(false)
  })

  it('同一个 requestId 换了标题、内容或原文档：另一个请求，REQUEST_ID_CONFLICT；别人用它也是', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.setMember(TEAM_SPACE, BOB, 'editor')
    const source = teamSource(store)
    const other = teamSource(store)
    const command = copyCommand()
    await service.copy(member(ALICE), source.id, command, upload(source.unitId), HTTP_ORIGIN)
    const conflicts = [
      service.copy(member(ALICE), source.id, { ...command, title: '另一个标题' }, upload(source.unitId), HTTP_ORIGIN),
      service.copy(member(ALICE), source.id, command, upload(source.unitId, '又改了一次'), HTTP_ORIGIN),
      service.copy(member(ALICE), other.id, command, upload(other.unitId), HTTP_ORIGIN),
      service.copy(member(BOB), source.id, command, upload(source.unitId), HTTP_ORIGIN),
    ]
    for (const conflict of conflicts)
      expect((await errorOf(conflict)).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.documents.size).toBe(3)
  })

  it('重放先于格式拦截与快照检查（M3-P3 设计 §3.1）：副本建好之后客户端被判为过旧、规则收紧，原样的重试照样拿到那份副本，不检查快照、不开事务', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    const command = copyCommand()
    const first = await service.copy(member(ALICE), source.id, command, upload(source.unitId), HTTP_ORIGIN)
    store.inspector.inspect.mockClear()
    store.transactions.run.mockClear()
    // 旧页面（P3 之前的写法）重试：不带构建与数据格式；摘要只看原文档、标题、内容与"公式待更新"
    const { clientBuild: _build, univerVersion: _version, profile: _profile, formatVersion: _format, ...oldPage } = command
    expect(await service.copy(member(ALICE), source.id, oldPage, upload(source.unitId), HTTP_ORIGIN)).toEqual({ ...first, replayed: true })
    expect(store.inspector.inspect).not.toHaveBeenCalled()
    expect(store.transactions.run).not.toHaveBeenCalled()
  })

  it('"公式待更新"（M3-P3 设计 §3.8）：记在副本上；计入摘要，同一个 requestId 而标记不同就是另一个请求', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    const command = copyCommand({ formulasPending: true })
    const body = upload(source.unitId)
    const copy = await service.copy(member(ALICE), source.id, command, body, HTTP_ORIGIN)
    expect(copy.formulasPending).toBe(true)
    expect(store.revisions.find(row => row.documentId === copy.id)?.payloadDigest).toEqual(conflictCopyPayloadDigest(source.id, TITLE, body.decompressed, true))
    expect((await errorOf(service.copy(member(ALICE), source.id, { ...command, formulasPending: false }, body, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('用在一次内容相同的保存上（回执）的 requestId：REQUEST_ID_CONFLICT，不建副本（审查 A3）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    const requestId = nextRequestId()
    store.receipts.push({ requestId, documentId: source.id, revision: 1, payloadDigest: Buffer.alloc(32), savedBy: ALICE, savedAt: new Date('2026-09-27T08:00:00.000Z') })
    expect((await errorOf(service.copy(member(ALICE), source.id, copyCommand({ requestId }), upload(source.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect([...store.documents.keys()]).toEqual([source.id])
    expect(store.audits).toEqual([])
  })

  it('新建、复制用过的 requestId：REQUEST_ID_CONFLICT（摘要以种类开头，不会相同）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    const requestId = nextRequestId()
    store.addRevision({ documentId: source.id, revision: 1, kind: 'created', requestId, payloadDigest: Buffer.alloc(32), source: null, savedBy: ALICE })
    expect((await errorOf(service.copy(member(ALICE), source.id, copyCommand({ requestId }), upload(source.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('重放时那份副本已经看不到了（进了回收站、被移走）：REQUEST_ID_CONFLICT，不透露它', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const source = teamSource(store)
    const command = copyCommand()
    const first = await service.copy(member(ALICE), source.id, command, upload(source.unitId), HTTP_ORIGIN)
    store.documentEntries.set(first.id, 'trash-entry')
    expect((await errorOf(service.copy(member(ALICE), source.id, command, upload(source.unitId), HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })
})
