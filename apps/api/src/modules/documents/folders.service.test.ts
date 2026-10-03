// FoldersService 的规则（M2-P4 设计 §3.4）：权限、层数上限、成环、requestId 的幂等、取锁的顺序。
// 递归的 SQL（展开子树、整棵加差值）由集成测试用真实数据库覆盖，这里的假仓储只保持同样的父子与层数语义。
import type { DocumentAccessPolicy } from './document-access-policy.ts'
import type { FolderRow } from './folders.repository.ts'
import { FOLDER_LIST_MAX_ITEMS, FOLDER_MAX_DEPTH } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { folderPermissionsOf } from './access-rules.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, HTTP_ORIGIN, member, TEAM_SPACE } from './documents.test-support.ts'
import { FoldersService } from './folders.service.ts'
import { folderCreatedPayloadDigest } from './payload-digest.ts'

const MISSING_FOLDER = '0199a2c4-0000-7000-8000-0000000000fd'

function setup() {
  const store = new FakeStore()
  const { transactions, folders, documents, entries, tree, spaces, policy, audit, writeAccess } = store.deps
  return { store, service: new FoldersService(transactions, folders, documents, entries, tree, spaces, policy, audit, writeAccess) }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error(`期望抛出 AppError，实际是 ${String(error)}`)
  return error
}

let requests = 0
function nextRequestId(): string {
  requests += 1
  return `0199a2c4-0000-7000-8000-${String(requests).padStart(12, '0')}`
}

/**
 * 真实的策略，只收紧"在这个空间里新建文件夹"这一位（其余照常）。
 * 真实规则里两个新建权限位始终相同（access-rules.ts），只有把它们分开，才看得出跨空间移动判的是哪一个。
 * 文件夹自己的权限（改名、移动、删除）不看这一位，所以收紧它只影响"目标空间"这一处判断
 */
function withoutFolderCreation(store: FakeStore): DocumentAccessPolicy {
  const { policy } = store
  return {
    accessOf: async (userId, document, transaction) => policy.accessOf(userId, document, transaction),
    visibleSpaces: async (actor, transaction) => policy.visibleSpaces(actor, transaction),
    accessOfMany: async (userId, documents, transaction) => policy.accessOfMany(userId, documents, transaction),
    spaceAccessOf: async (actor, spaceId, transaction) => {
      const access = await policy.spaceAccessOf(actor, spaceId, transaction)
      return access === undefined ? undefined : { ...access, permissions: { ...access.permissions, canCreateFolders: false } }
    },
  }
}

/** 在某个空间里建一条 depth 层的链，返回每一层的文件夹（第 0 项是第 1 层） */
function chain(store: FakeStore, spaceId: string, depth: number): FolderRow[] {
  const rows: FolderRow[] = []
  for (let level = 0; level < depth; level += 1)
    rows.push(store.addFolder({ spaceId, parentId: rows.at(-1)?.id ?? null, name: `第 ${level + 1} 层` }))
  return rows
}

describe('FoldersService.create', () => {
  it('在个人空间的根目录下新建：层数是 1，记审计；锁的顺序是先空间树、再空间行', async () => {
    const { store, service } = setup()
    const folder = await service.create(member(ALICE), { spaceId: ALICE_SPACE, name: '资料', requestId: nextRequestId() }, HTTP_ORIGIN)
    expect(folder).toMatchObject({ spaceId: ALICE_SPACE, parentId: null, name: '资料', depth: 1, permissions: { canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canDelete: true } })
    expect(store.treeLocks).toEqual([[ALICE_SPACE]])
    expect(store.tree.lock.mock.invocationCallOrder[0]).toBeLessThan(store.spaces.holdSpace.mock.invocationCallOrder[0] ?? 0)
    expect(store.audits).toEqual([{
      action: 'folders.created',
      actor: { type: 'user', id: ALICE },
      target: { type: 'folder', id: folder.id },
      origin: HTTP_ORIGIN,
      // 只记位置，不记名称（M2-P6 复核 M-1）
      details: { spaceId: ALICE_SPACE, parentId: null },
    }])
  })

  it('建在父文件夹下：层数是父的层数加一；同一个文件夹里允许同名', async () => {
    const { store, service } = setup()
    const parent = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const first = await service.create(member(ALICE), { spaceId: ALICE_SPACE, parentId: parent.id, name: '归档', requestId: nextRequestId() }, HTTP_ORIGIN)
    const second = await service.create(member(ALICE), { spaceId: ALICE_SPACE, parentId: parent.id, name: '归档', requestId: nextRequestId() }, HTTP_ORIGIN)
    expect([first.depth, second.depth]).toEqual([2, 2])
    expect(second.id).not.toBe(first.id)
  })

  it(`第 ${FOLDER_MAX_DEPTH} 层下面不能再建：FOLDER_DEPTH_EXCEEDED，什么也不写`, async () => {
    const { store, service } = setup()
    const levels = chain(store, ALICE_SPACE, FOLDER_MAX_DEPTH)
    const deepest = levels.at(-1)
    expect(deepest?.depth).toBe(FOLDER_MAX_DEPTH)
    const error = await errorOf(service.create(member(ALICE), { spaceId: ALICE_SPACE, parentId: deepest?.id ?? '', name: '再一层', requestId: nextRequestId() }, HTTP_ORIGIN))
    expect(error.code).toBe('FOLDER_DEPTH_EXCEEDED')
    expect(store.folders.size).toBe(FOLDER_MAX_DEPTH)
    expect(store.audits).toEqual([])
  })

  it('父文件夹在别的空间里、不存在：都是 NOT_FOUND，响应一致', async () => {
    const { store, service } = setup()
    const elsewhere = store.addFolder({ spaceId: BOB_SPACE, name: '鲍勃的资料' })
    const foreign = await errorOf(service.create(member(ALICE), { spaceId: ALICE_SPACE, parentId: elsewhere.id, name: '资料', requestId: nextRequestId() }, HTTP_ORIGIN))
    const missing = await errorOf(service.create(member(ALICE), { spaceId: ALICE_SPACE, parentId: MISSING_FOLDER, name: '资料', requestId: nextRequestId() }, HTTP_ORIGIN))
    expect([foreign.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(foreign.message).toBe(missing.message)
  })

  it('看不到的空间是 NOT_FOUND；查看者能看却不能新建，是 PERMISSION_DENIED', async () => {
    const { store, service } = setup()
    const unseen = await errorOf(service.create(member(ALICE), { spaceId: TEAM_SPACE, name: '资料', requestId: nextRequestId() }, HTTP_ORIGIN))
    expect(unseen.code).toBe('NOT_FOUND')
    // 看不到就不取锁（M2-P2 的做法）
    expect(store.treeLocks).toEqual([])

    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    const denied = await errorOf(service.create(member(ALICE), { spaceId: TEAM_SPACE, name: '资料', requestId: nextRequestId() }, HTTP_ORIGIN))
    expect(denied.code).toBe('PERMISSION_DENIED')
    expect(denied.message).toBe('没有在这个空间里新建文件夹的权限')
    expect(store.treeLocks).toEqual([])

    store.setMember(TEAM_SPACE, ALICE, 'editor')
    expect((await service.create(member(ALICE), { spaceId: TEAM_SPACE, name: '资料', requestId: nextRequestId() }, HTTP_ORIGIN)).depth).toBe(1)
  })

  it('归档的空间：能看却不能新建，说明空间已归档', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    const error = await errorOf(service.create(member(ALICE), { spaceId: TEAM_SPACE, name: '资料', requestId: nextRequestId() }, HTTP_ORIGIN))
    expect([error.code, error.message]).toEqual(['PERMISSION_DENIED', '空间已归档，只能查看'])
  })

  it('同一个 requestId 重发：返回同一个文件夹、不再建；换了名称或位置是另一个请求，拒绝', async () => {
    const { store, service } = setup()
    const requestId = nextRequestId()
    const command = { spaceId: ALICE_SPACE, name: '资料', requestId }
    const first = await service.create(member(ALICE), command, HTTP_ORIGIN)
    expect(first.replayed).toBe(false)
    // 重放：同一个文件夹，标为重放（M2-P6 复核第二批 S-1）
    expect(await service.create(member(ALICE), command, HTTP_ORIGIN)).toEqual({ ...first, replayed: true })
    expect(store.folders.size).toBe(1)
    // 重放不再记审计
    expect(store.audits).toHaveLength(1)

    const conflict = await errorOf(service.create(member(ALICE), { ...command, name: '归档' }, HTTP_ORIGIN))
    expect(conflict.code).toBe('REQUEST_ID_CONFLICT')
    // 别人拿同一个 requestId 也拒绝（不透露那个文件夹的任何信息）
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    expect((await errorOf(service.create(member(ALICE), { ...command, spaceId: TEAM_SPACE }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('重放只要求仍能看到这个空间（M2-P6 复核 A 的 S-4）：建好之后被降为查看者、空间被归档，重发拿到同一个文件夹，不取锁；不是重放仍是 PERMISSION_DENIED', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const command = { spaceId: TEAM_SPACE, name: '资料', requestId: nextRequestId() }
    const first = await service.create(member(ALICE), command, HTTP_ORIGIN)
    const locksAfterCreate = store.treeLocks.length

    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    // 同一个文件夹，权限按现在的角色给
    expect(await service.create(member(ALICE), command, HTTP_ORIGIN)).toEqual({ ...first, permissions: folderPermissionsOf('viewer'), replayed: true })
    const notReplay = await errorOf(service.create(member(ALICE), { ...command, requestId: nextRequestId() }, HTTP_ORIGIN))
    expect([notReplay.code, notReplay.message]).toEqual(['PERMISSION_DENIED', '没有在这个空间里新建文件夹的权限'])

    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect((await service.create(member(ALICE), command, HTTP_ORIGIN)).id).toBe(first.id)
    const archived = await errorOf(service.create(member(ALICE), { ...command, requestId: nextRequestId() }, HTTP_ORIGIN))
    expect([archived.code, archived.message]).toEqual(['PERMISSION_DENIED', '空间已归档，只能查看'])
    // 不能新建的请求（重放与否）都不取空间树的锁与空间行的锁：不让结构性的改动为它排队
    expect(store.treeLocks).toHaveLength(locksAfterCreate)
    expect(store.folders.size).toBe(1)
    expect(store.audits).toHaveLength(1)
  })

  it('同一个请求的两次同时到达（锁外都没查到）：后拿到树锁的一方在锁下查到前一方建好的，是重放，等锁期间被降为查看者也照样返回、不再建；不是重放的、等锁期间被降为查看者，是 PERMISSION_DENIED', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const command = { spaceId: TEAM_SPACE, name: '资料', requestId: nextRequestId() }
    let earlier: string | undefined
    // 等树锁的期间：同一个请求的另一次先拿到锁、建好并提交了，自己随即被降为查看者
    store.tree.lock.mockImplementationOnce(async (spaceIds: readonly string[]) => {
      store.treeLocks.push([...spaceIds])
      earlier = store.addFolder({ spaceId: TEAM_SPACE, name: command.name, requestId: command.requestId, payloadDigest: folderCreatedPayloadDigest(TEAM_SPACE, undefined, command.name) }).id
      store.setMember(TEAM_SPACE, ALICE, 'viewer')
    })
    const replayed = await service.create(member(ALICE), command, HTTP_ORIGIN)
    expect(replayed).toMatchObject({ id: earlier, permissions: folderPermissionsOf('viewer'), replayed: true })
    expect(store.folders.size).toBe(1)
    expect(store.audits).toEqual([])

    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.tree.lock.mockImplementationOnce(async (spaceIds: readonly string[]) => {
      store.treeLocks.push([...spaceIds])
      store.setMember(TEAM_SPACE, ALICE, 'viewer')
    })
    expect((await errorOf(service.create(member(ALICE), { ...command, requestId: nextRequestId() }, HTTP_ORIGIN))).code).toBe('PERMISSION_DENIED')
    expect(store.folders.size).toBe(1)
  })

  it('看不到它所在的空间了（被移出）：重放是冲突（REQUEST_ID_CONFLICT，与新建文档一致），不透露那个文件夹；不是重放的新建是 NOT_FOUND', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const command = { spaceId: TEAM_SPACE, name: '资料', requestId: nextRequestId() }
    await service.create(member(ALICE), command, HTTP_ORIGIN)
    store.setMember(TEAM_SPACE, ALICE, undefined)
    expect((await errorOf(service.create(member(ALICE), command, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect((await errorOf(service.create(member(ALICE), { ...command, requestId: nextRequestId() }, HTTP_ORIGIN))).code).toBe('NOT_FOUND')
  })
})

/**
 * 是不是同一个请求按新建时存下的请求摘要判断（M2 Codex 评审 CX6）：原来拿请求与文件夹现在的名称、位置比较，
 * 建好之后改名、移动过，原样的重试被判成冲突；载荷不同、却碰巧与现状相同的请求反而被当成重放
 */
describe('FoldersService.create 的重放按新建时的请求（M2 Codex 评审 CX6）', () => {
  it('建好之后改名：原样重发是重放，返回同一个文件夹现在的样子（新的名称），不再建、不记审计', async () => {
    const { store, service } = setup()
    const command = { spaceId: ALICE_SPACE, name: '待整理', requestId: nextRequestId() }
    const first = await service.create(member(ALICE), command, HTTP_ORIGIN)
    await service.update(member(ALICE), first.id, { name: '已整理' }, HTTP_ORIGIN)
    const replayed = await service.create(member(ALICE), command, HTTP_ORIGIN)
    expect(replayed).toMatchObject({ id: first.id, name: '已整理', replayed: true })
    expect(store.folders.size).toBe(1)
    expect(store.audits.map(event => event.action)).toEqual(['folders.created', 'folders.renamed'])
  })

  it('建好之后在同一个空间里移动、移到别的空间：原样重发都是重放，位置与权限按它现在所在的空间给', async () => {
    const { store, service } = setup()
    const parent = store.addFolder({ spaceId: ALICE_SPACE, name: '上一层' })
    const command = { spaceId: ALICE_SPACE, parentId: parent.id, name: '资料', requestId: nextRequestId() }
    const first = await service.create(member(ALICE), command, HTTP_ORIGIN)
    await service.update(member(ALICE), first.id, { parentId: null }, HTTP_ORIGIN)
    expect(await service.create(member(ALICE), command, HTTP_ORIGIN)).toMatchObject({ id: first.id, parentId: null, depth: 1, replayed: true })

    store.setMember(TEAM_SPACE, ALICE, 'editor')
    await service.move(member(ALICE), first.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN)
    const moved = await service.create(member(ALICE), command, HTTP_ORIGIN)
    expect(moved).toMatchObject({ id: first.id, name: first.name, spaceId: TEAM_SPACE, parentId: null, depth: 1, replayed: true })
    expect(moved.permissions).toEqual(folderPermissionsOf('editor'))
    expect(store.folders.size).toBe(2)
  })

  it('同一个 requestId、载荷不同：冲突——即使这次的载荷与文件夹现在的样子相同（改名之后拿新名称重发）', async () => {
    const { service } = setup()
    const command = { spaceId: ALICE_SPACE, name: '待整理', requestId: nextRequestId() }
    const first = await service.create(member(ALICE), command, HTTP_ORIGIN)
    await service.update(member(ALICE), first.id, { name: '已整理' }, HTTP_ORIGIN)
    expect((await errorOf(service.create(member(ALICE), { ...command, name: '已整理' }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect((await errorOf(service.create(member(ALICE), { ...command, parentId: first.id }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('移到了我看得到的空间、原来的空间我已经看不到：原样重发是重放，权限按它现在所在的空间给，不取锁（先查重放，不先要求这次请求里的空间，M2 Codex 评审复验的一般 4）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    const command = { spaceId: TEAM_SPACE, name: '资料', requestId: nextRequestId() }
    const first = await service.create(member(ALICE), command, HTTP_ORIGIN)
    await service.move(member(ALICE), first.id, { spaceId: ALICE_SPACE }, HTTP_ORIGIN)
    store.setMember(TEAM_SPACE, ALICE, undefined)
    const locks = store.treeLocks.length
    const replayed = await service.create(member(ALICE), command, HTTP_ORIGIN)
    expect(replayed).toMatchObject({ id: first.id, spaceId: ALICE_SPACE, parentId: null, replayed: true })
    expect(replayed.permissions).toEqual(folderPermissionsOf('admin'))
    expect(store.treeLocks).toHaveLength(locks)
    expect(store.folders.size).toBe(1)
  })

  it('移到了看不到的空间：原样重发是冲突，不透露它现在在哪里', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const command = { spaceId: ALICE_SPACE, name: '资料', requestId: nextRequestId() }
    const first = await service.create(member(ALICE), command, HTTP_ORIGIN)
    await service.move(member(ALICE), first.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN)
    store.setMember(TEAM_SPACE, ALICE, undefined)
    expect((await errorOf(service.create(member(ALICE), command, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })
})

describe('FoldersService.list', () => {
  it('省略 parentId 是空间的根目录；按名称排序；只列这一层', async () => {
    const { store, service } = setup()
    const parent = store.addFolder({ spaceId: ALICE_SPACE, name: 'b 资料' })
    store.addFolder({ spaceId: ALICE_SPACE, name: 'a 归档' })
    store.addFolder({ spaceId: ALICE_SPACE, parentId: parent.id, name: '里面' })
    const root = await service.list(member(ALICE), { spaceId: ALICE_SPACE })
    expect(root.items.map(item => item.name)).toEqual(['a 归档', 'b 资料'])
    expect(root.truncated).toBe(false)
    expect((await service.list(member(ALICE), { spaceId: ALICE_SPACE, parentId: parent.id })).items.map(item => item.name)).toEqual(['里面'])
  })

  it(`超过 ${FOLDER_LIST_MAX_ITEMS} 条：只给前这么多条，truncated 为真`, async () => {
    const { store, service } = setup()
    for (let index = 0; index <= FOLDER_LIST_MAX_ITEMS; index += 1)
      store.addFolder({ spaceId: ALICE_SPACE, name: `第 ${String(index).padStart(4, '0')} 个` })
    const page = await service.list(member(ALICE), { spaceId: ALICE_SPACE })
    expect(page.items).toHaveLength(FOLDER_LIST_MAX_ITEMS)
    expect(page.truncated).toBe(true)
  })

  it('查看者能列出（没有改动的权限）；看不到的空间与不存在的父文件夹都是 NOT_FOUND', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const page = await service.list(member(BOB), { spaceId: TEAM_SPACE })
    expect(page.items[0]?.permissions).toEqual({ canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false })
    expect((await errorOf(service.list(member(ALICE), { spaceId: TEAM_SPACE }))).code).toBe('NOT_FOUND')
    expect((await errorOf(service.list(member(BOB), { spaceId: TEAM_SPACE, parentId: MISSING_FOLDER }))).code).toBe('NOT_FOUND')
  })
})

describe('FoldersService.update', () => {
  it('改名：记审计；名称没有变化时不改、不记审计', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const renamed = await service.update(member(ALICE), folder.id, { name: '归档' }, HTTP_ORIGIN)
    expect(renamed.name).toBe('归档')
    expect(store.audits).toEqual([{
      action: 'folders.renamed',
      actor: { type: 'user', id: ALICE },
      target: { type: 'folder', id: folder.id },
      origin: HTTP_ORIGIN,
      // 只记位置，不记改动前后的名称（M2-P6 复核 M-1）
      details: { spaceId: ALICE_SPACE, parentId: null },
    }])
    await service.update(member(ALICE), folder.id, { name: '归档' }, HTTP_ORIGIN)
    expect(store.audits).toHaveLength(1)
  })

  it('移到另一个文件夹下：整棵子树的层数一起变；移回根目录再变回来', async () => {
    const { store, service } = setup()
    const [top, middle, leaf] = chain(store, ALICE_SPACE, 3)
    const target = store.addFolder({ spaceId: ALICE_SPACE, name: '目标' })
    const moved = await service.update(member(ALICE), middle?.id ?? '', { parentId: target.id }, HTTP_ORIGIN)
    expect(moved).toMatchObject({ parentId: target.id, depth: 2 })
    expect(store.folders.get(leaf?.id ?? '')?.depth).toBe(3)
    expect(store.audits.at(-1)).toMatchObject({
      action: 'folders.moved',
      details: { fromSpaceId: ALICE_SPACE, fromParentId: top?.id, toSpaceId: ALICE_SPACE, toParentId: target.id },
    })

    const back = await service.update(member(ALICE), middle?.id ?? '', { parentId: null }, HTTP_ORIGIN)
    expect(back).toMatchObject({ parentId: null, depth: 1 })
    expect(store.folders.get(leaf?.id ?? '')?.depth).toBe(2)
  })

  it('移进自己或自己的子文件夹：FOLDER_CYCLE，位置不变', async () => {
    const { store, service } = setup()
    const [top, middle, leaf] = chain(store, ALICE_SPACE, 3)
    for (const target of [top?.id, middle?.id, leaf?.id])
      expect((await errorOf(service.update(member(ALICE), top?.id ?? '', { parentId: target }, HTTP_ORIGIN))).code, String(target)).toBe('FOLDER_CYCLE')
    expect(store.folders.get(top?.id ?? '')).toMatchObject({ parentId: null, depth: 1 })
  })

  it('子树装不下时拒绝：整棵移过去会超过层数上限', async () => {
    const { store, service } = setup()
    const deep = chain(store, ALICE_SPACE, FOLDER_MAX_DEPTH - 1)
    const target = store.addFolder({ spaceId: ALICE_SPACE, name: '目标' })
    // 这棵子树有 9 层，挂到第 1 层下面之后最深会到第 10 层：正好放得下
    const under = chain(store, ALICE_SPACE, 2)
    expect((await service.update(member(ALICE), deep[0]?.id ?? '', { parentId: target.id }, HTTP_ORIGIN)).depth).toBe(2)
    // 再往第 2 层下面挪就装不下了
    const error = await errorOf(service.update(member(ALICE), deep[0]?.id ?? '', { parentId: under[1]?.id ?? '' }, HTTP_ORIGIN))
    expect(error.code).toBe('FOLDER_DEPTH_EXCEEDED')
    expect(store.folders.get(deep[0]?.id ?? '')).toMatchObject({ parentId: target.id, depth: 2 })
  })

  it('层数把回收站里的子孙也算进去（M2-P6 复核 B 的 B3）：它们跟着移动、恢复时回到原处，整棵放不下就拒绝', async () => {
    const { store, service } = setup()
    const [top, middle, leaf] = chain(store, ALICE_SPACE, 3)
    // 第 2、3 层在回收站里（一个删除单元）：正常状态的只有第 1 层
    for (const trashed of [middle, leaf])
      store.folderEntries.set(trashed?.id ?? '', 'entry')
    const deep = chain(store, ALICE_SPACE, FOLDER_MAX_DEPTH - 2)
    // 挂到第 8 层下面：回收站里的第 3 层会到第 11 层
    const error = await errorOf(service.update(member(ALICE), top?.id ?? '', { parentId: deep.at(-1)?.id ?? '' }, HTTP_ORIGIN))
    expect(error.code).toBe('FOLDER_DEPTH_EXCEEDED')
    expect([top, middle, leaf].map(row => store.folders.get(row?.id ?? '')?.depth)).toEqual([1, 2, 3])
    // 挂到第 7 层下面正好放得下：回收站里的子孙一起降到第 9、10 层
    expect((await service.update(member(ALICE), top?.id ?? '', { parentId: deep.at(-2)?.id ?? '' }, HTTP_ORIGIN)).depth).toBe(8)
    expect([middle, leaf].map(row => store.folders.get(row?.id ?? '')?.depth)).toEqual([9, 10])
  })

  it('目标文件夹在别的空间里：NOT_FOUND（跨空间移动另有接口）', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const elsewhere = store.addFolder({ spaceId: BOB_SPACE, name: '鲍勃的资料' })
    expect((await errorOf(service.update(member(ALICE), folder.id, { parentId: elsewhere.id }, HTTP_ORIGIN))).code).toBe('NOT_FOUND')
  })

  it('查看者不能改名、不能移动；看不到的空间里的文件夹与不存在的都是 NOT_FOUND', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const rename = await errorOf(service.update(member(BOB), folder.id, { name: '归档' }, HTTP_ORIGIN))
    expect([rename.code, rename.message]).toEqual(['PERMISSION_DENIED', '没有给这个文件夹改名的权限'])
    const move = await errorOf(service.update(member(BOB), folder.id, { parentId: null }, HTTP_ORIGIN))
    expect([move.code, move.message]).toEqual(['PERMISSION_DENIED', '没有移动这个文件夹的权限'])
    // 不能做的请求不取锁
    expect(store.treeLocks).toEqual([])

    const unseen = await errorOf(service.update(member(ALICE), folder.id, { name: '归档' }, HTTP_ORIGIN))
    const missing = await errorOf(service.update(member(ALICE), MISSING_FOLDER, { name: '归档' }, HTTP_ORIGIN))
    expect([unseen.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(unseen.message).toBe(missing.message)
  })

  it('两项都给：一次判断两项权限，改名与移动各记一条审计', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const target = store.addFolder({ spaceId: ALICE_SPACE, name: '目标' })
    const updated = await service.update(member(ALICE), folder.id, { name: '归档', parentId: target.id }, HTTP_ORIGIN)
    expect(updated).toMatchObject({ name: '归档', parentId: target.id, depth: 2 })
    expect(store.audits.map(event => event.action)).toEqual(['folders.renamed', 'folders.moved'])
  })
})

describe('FoldersService.move', () => {
  /** 爱丽丝个人空间里的一棵两层子树，每一层放一份文档 */
  function subtree(store: FakeStore) {
    const [top, leaf] = chain(store, ALICE_SPACE, 2)
    const atTop = store.addDocument({ spaceId: ALICE_SPACE, folderId: top?.id ?? null, title: '上层的' })
    const deep = store.addDocument({ spaceId: ALICE_SPACE, folderId: leaf?.id ?? null, title: '深处的' })
    return { top: top ?? store.addFolder({}), leaf: leaf ?? store.addFolder({}), atTop, deep }
  }

  it('跨空间移动：整棵子树（含深层的文档）都换了空间，文档的写入代次都加一、写入权一次收回，审计带两边的位置与份数', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const { top, leaf, atTop, deep } = subtree(store)
    const target = store.addFolder({ spaceId: TEAM_SPACE, name: '目标' })

    const moved = await service.move(member(ALICE), top.id, { spaceId: TEAM_SPACE, folderId: target.id }, HTTP_ORIGIN)
    expect(moved).toMatchObject({ spaceId: TEAM_SPACE, parentId: target.id, depth: 2 })
    // 到了新空间只是编辑者：不能再把它移走
    expect(moved.permissions).toEqual({ canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canDelete: true })
    // 子树里的文件夹：空间与层数都变了，父子关系不变
    expect(store.folders.get(leaf.id)).toMatchObject({ spaceId: TEAM_SPACE, parentId: top.id, depth: 3 })
    // 子树里的文档：换了空间、代次加一，仍在各自的文件夹里
    expect(store.documents.get(atTop.id)).toMatchObject({ spaceId: TEAM_SPACE, folderId: top.id })
    expect(store.documents.get(deep.id)).toMatchObject({ spaceId: TEAM_SPACE, folderId: leaf.id })
    expect([store.writeEpochs.get(atTop.id), store.writeEpochs.get(deep.id)]).toEqual([1, 1])
    // 一次收回整批文档的写入权，不逐份调用
    expect(store.revocations).toEqual([{ kind: 'documents', documentIds: [atTop.id, deep.id].toSorted() }])
    expect(store.audits).toEqual([{
      action: 'folders.moved',
      actor: { type: 'user', id: ALICE },
      target: { type: 'folder', id: top.id },
      origin: HTTP_ORIGIN,
      details: { fromSpaceId: ALICE_SPACE, fromParentId: null, toSpaceId: TEAM_SPACE, toParentId: target.id, folders: 2, documents: 2 },
    }])
  })

  it('移到目标空间的根目录：层数从头算，子树跟着变', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const [top, middle, leaf] = chain(store, ALICE_SPACE, 3)
    const moved = await service.move(member(ALICE), middle?.id ?? '', { spaceId: TEAM_SPACE }, HTTP_ORIGIN)
    expect(moved).toMatchObject({ spaceId: TEAM_SPACE, parentId: null, depth: 1 })
    expect(store.folders.get(leaf?.id ?? '')).toMatchObject({ spaceId: TEAM_SPACE, depth: 2 })
    // 留在原空间的那一层不动
    expect(store.folders.get(top?.id ?? '')).toMatchObject({ spaceId: ALICE_SPACE, depth: 1 })
  })

  it('两个空间的树锁一次取（顺序由 SpaceTreeRepository 定），空间行按 id 排序取', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    await service.move(member(ALICE), folder.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN)
    expect(store.treeLocks).toEqual([[ALICE_SPACE, TEAM_SPACE]])
    expect(store.spaces.holdSpace.mock.calls.map(call => call[0])).toEqual([ALICE_SPACE, TEAM_SPACE].toSorted())
  })

  it('要源空间的空间管理员：编辑者不行；不能做的请求不取锁、不动任何行', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const document = store.addDocument({ spaceId: TEAM_SPACE, folderId: folder.id })
    const error = await errorOf(service.move(member(ALICE), folder.id, { spaceId: ALICE_SPACE }, HTTP_ORIGIN))
    expect([error.code, error.message]).toEqual(['PERMISSION_DENIED', '只有空间管理员能把文件夹移出这个空间'])
    expect(store.treeLocks).toEqual([])
    expect(store.writeEpochs.size).toBe(0)
    expect(store.documents.get(document.id)?.spaceId).toBe(TEAM_SPACE)

    store.setMember(TEAM_SPACE, ALICE, 'admin')
    expect((await service.move(member(ALICE), folder.id, { spaceId: ALICE_SPACE }, HTTP_ORIGIN)).spaceId).toBe(ALICE_SPACE)
  })

  it('目标空间看不到、不存在：NOT_FOUND；已归档：SPACE_ARCHIVED；只能查看：PERMISSION_DENIED', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const unseen = await errorOf(service.move(member(ALICE), folder.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN))
    const missing = await errorOf(service.move(member(ALICE), folder.id, { spaceId: MISSING_FOLDER }, HTTP_ORIGIN))
    expect([unseen.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(unseen.message).toBe(missing.message)

    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.space(TEAM_SPACE).status = 'archived'
    expect((await errorOf(service.move(member(ALICE), folder.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN))).code).toBe('SPACE_ARCHIVED')

    store.space(TEAM_SPACE).status = 'active'
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    const denied = await errorOf(service.move(member(ALICE), folder.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN))
    expect([denied.code, denied.message]).toEqual(['PERMISSION_DENIED', '没有在目标空间里新建的权限'])
    expect(store.folders.get(folder.id)?.spaceId).toBe(ALICE_SPACE)
  })

  it('判的是目标空间的"新建文件夹"权限，不是"新建文档"（审查 A 建议 5）', async () => {
    const store = new FakeStore()
    const { transactions, folders, documents, entries, tree, spaces, audit, writeAccess } = store.deps
    const service = new FoldersService(transactions, folders, documents, entries, tree, spaces, withoutFolderCreation(store), audit, writeAccess)
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    // 目标空间里能新建文档、不能新建文件夹：搬文件夹进去要被拒绝
    const denied = await errorOf(service.move(member(ALICE), folder.id, { spaceId: ALICE_SPACE }, HTTP_ORIGIN))
    expect([denied.code, denied.message]).toEqual(['PERMISSION_DENIED', '没有在目标空间里新建的权限'])
    expect(store.folders.get(folder.id)?.spaceId).toBe(TEAM_SPACE)
  })

  it('源空间已归档：所有人至多是查看者，移不走', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const error = await errorOf(service.move(member(ALICE), folder.id, { spaceId: ALICE_SPACE }, HTTP_ORIGIN))
    expect([error.code, error.message]).toEqual(['PERMISSION_DENIED', '空间已归档，只能查看'])
  })

  it('目标就是现在所在的空间：按空间内移动处理（编辑者就行，代次不变，不收回写入权）；重试是幂等的', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const document = store.addDocument({ spaceId: TEAM_SPACE, folderId: folder.id })
    const target = store.addFolder({ spaceId: TEAM_SPACE, name: '目标' })
    const moved = await service.move(member(ALICE), folder.id, { spaceId: TEAM_SPACE, folderId: target.id }, HTTP_ORIGIN)
    expect(moved).toMatchObject({ parentId: target.id, depth: 2 })
    expect(store.writeEpochs.size).toBe(0)
    expect(store.revocations).toEqual([])
    expect(store.treeLocks).toEqual([[TEAM_SPACE]])
    // 文档跟着文件夹留在原处：位置与代次都不变
    expect(store.documents.get(document.id)).toMatchObject({ spaceId: TEAM_SPACE, folderId: folder.id })
    // 移动成功之后重试同一个请求：没有变化，不再记审计、不再递增代次
    await service.move(member(ALICE), folder.id, { spaceId: TEAM_SPACE, folderId: target.id }, HTTP_ORIGIN)
    expect(store.audits).toHaveLength(1)
    expect(store.writeEpochs.size).toBe(0)
  })

  it('同一个空间里移进自己的子文件夹：FOLDER_CYCLE，位置不变', async () => {
    const { store, service } = setup()
    const [top, , leaf] = chain(store, ALICE_SPACE, 3)
    const error = await errorOf(service.move(member(ALICE), top?.id ?? '', { spaceId: ALICE_SPACE, folderId: leaf?.id }, HTTP_ORIGIN))
    expect(error.code).toBe('FOLDER_CYCLE')
    expect(store.folders.get(top?.id ?? '')).toMatchObject({ parentId: null, depth: 1 })
  })

  it('整棵子树在目标空间里装不下：FOLDER_DEPTH_EXCEEDED，什么也不改', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    // 9 层的一棵子树：挂到目标空间的第 2 层下面就超了
    const deep = chain(store, ALICE_SPACE, FOLDER_MAX_DEPTH - 1)
    const document = store.addDocument({ spaceId: ALICE_SPACE, folderId: deep.at(-1)?.id ?? null })
    const [, second] = chain(store, TEAM_SPACE, 2)
    const error = await errorOf(service.move(member(ALICE), deep[0]?.id ?? '', { spaceId: TEAM_SPACE, folderId: second?.id }, HTTP_ORIGIN))
    expect(error.code).toBe('FOLDER_DEPTH_EXCEEDED')
    expect(store.folders.get(deep[0]?.id ?? '')).toMatchObject({ spaceId: ALICE_SPACE, parentId: null, depth: 1 })
    expect(store.documents.get(document.id)?.spaceId).toBe(ALICE_SPACE)
    expect(store.writeEpochs.size).toBe(0)
  })

  it('层数把回收站里的子孙也算进去（M2-P6 复核 B 的 B3）：跨空间移动时同样，目标空间里放不下就拒绝，什么也不改', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const [top, middle, leaf] = chain(store, ALICE_SPACE, 3)
    for (const trashed of [middle, leaf])
      store.folderEntries.set(trashed?.id ?? '', 'entry')
    const deep = chain(store, TEAM_SPACE, FOLDER_MAX_DEPTH - 2)
    const error = await errorOf(service.move(member(ALICE), top?.id ?? '', { spaceId: TEAM_SPACE, folderId: deep.at(-1)?.id }, HTTP_ORIGIN))
    expect(error.code).toBe('FOLDER_DEPTH_EXCEEDED')
    expect([top, middle, leaf].map(row => store.folders.get(row?.id ?? ''))).toMatchObject([
      { spaceId: ALICE_SPACE, depth: 1 },
      { spaceId: ALICE_SPACE, depth: 2 },
      { spaceId: ALICE_SPACE, depth: 3 },
    ])
    expect((await service.move(member(ALICE), top?.id ?? '', { spaceId: TEAM_SPACE, folderId: deep.at(-2)?.id }, HTTP_ORIGIN)).depth).toBe(8)
    expect([middle, leaf].map(row => store.folders.get(row?.id ?? ''))).toMatchObject([{ spaceId: TEAM_SPACE, depth: 9 }, { spaceId: TEAM_SPACE, depth: 10 }])
  })

  it('目标文件夹在别的空间里、不存在：都是 NOT_FOUND，什么也不改', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const elsewhere = store.addFolder({ spaceId: ALICE_SPACE, name: '还在原空间' })
    const foreign = await errorOf(service.move(member(ALICE), folder.id, { spaceId: TEAM_SPACE, folderId: elsewhere.id }, HTTP_ORIGIN))
    const missing = await errorOf(service.move(member(ALICE), folder.id, { spaceId: TEAM_SPACE, folderId: MISSING_FOLDER }, HTTP_ORIGIN))
    expect([foreign.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(foreign.message).toBe(missing.message)
    expect(store.folders.get(folder.id)?.spaceId).toBe(ALICE_SPACE)
    expect(store.audits).toEqual([])
  })

  it('看不到的文件夹与不存在的文件夹：同一个 NOT_FOUND，不取锁', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: BOB_SPACE, name: '鲍勃的资料' })
    const unseen = await errorOf(service.move(member(ALICE), folder.id, { spaceId: ALICE_SPACE }, HTTP_ORIGIN))
    const missing = await errorOf(service.move(member(ALICE), MISSING_FOLDER, { spaceId: ALICE_SPACE }, HTTP_ORIGIN))
    expect([unseen.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(unseen.message).toBe(missing.message)
    expect(store.treeLocks).toEqual([])
  })
})
