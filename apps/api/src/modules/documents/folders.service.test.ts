// FoldersService 的规则（M2-P4 设计 §3.4）：权限、层数上限、成环、requestId 的幂等、取锁的顺序。
// 递归的 SQL（展开子树、整棵加差值）由集成测试用真实数据库覆盖，这里的假仓储只保持同样的父子与层数语义。
import type { FolderRow } from './folders.repository.ts'
import { FOLDER_LIST_MAX_ITEMS, FOLDER_MAX_DEPTH } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, HTTP_ORIGIN, member, TEAM_SPACE } from './documents.test-support.ts'
import { FoldersService } from './folders.service.ts'

const MISSING_FOLDER = '0199a2c4-0000-7000-8000-0000000000fd'

function setup() {
  const store = new FakeStore()
  const { transactions, folders, tree, spaces, policy, audit } = store.deps
  return { store, service: new FoldersService(transactions, folders, tree, spaces, policy, audit) }
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
    expect(folder).toMatchObject({ spaceId: ALICE_SPACE, parentId: null, name: '资料', depth: 1, permissions: { canRename: true, canMoveWithinSpace: true } })
    expect(store.treeLocks).toEqual([[ALICE_SPACE]])
    expect(store.tree.lock.mock.invocationCallOrder[0]).toBeLessThan(store.spaces.holdSpace.mock.invocationCallOrder[0] ?? 0)
    expect(store.audits).toEqual([{
      action: 'folders.created',
      actor: { type: 'user', id: ALICE },
      target: { type: 'folder', id: folder.id },
      origin: HTTP_ORIGIN,
      details: { spaceId: ALICE_SPACE, parentId: null, name: '资料' },
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
    expect(await service.create(member(ALICE), command, HTTP_ORIGIN)).toEqual(first)
    expect(store.folders.size).toBe(1)
    // 重放不再记审计
    expect(store.audits).toHaveLength(1)

    const conflict = await errorOf(service.create(member(ALICE), { ...command, name: '归档' }, HTTP_ORIGIN))
    expect(conflict.code).toBe('REQUEST_ID_CONFLICT')
    // 别人拿同一个 requestId 也拒绝（不透露那个文件夹的任何信息）
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    expect((await errorOf(service.create(member(ALICE), { ...command, spaceId: TEAM_SPACE }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
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
    expect(page.items[0]?.permissions).toEqual({ canRename: false, canMoveWithinSpace: false })
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
      details: { spaceId: ALICE_SPACE, from: '资料', to: '归档' },
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
    expect(store.audits.at(-1)).toMatchObject({ action: 'folders.moved', details: { spaceId: ALICE_SPACE, from: top?.id, to: target.id } })

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
