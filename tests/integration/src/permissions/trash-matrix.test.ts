// 权限矩阵：回收站（按空间列出、恢复、永久删除）与搜索的范围——P4-S3 spec §3、§4、§5、§6，
// 00 号计划书 §5.3 的"回收站按空间划分，删除者和空间管理员可以恢复"、§5.5 的可见性；A14 的文档管理部分（US-M2-14）。
// 预期逐格写在表里，不调用生产代码的规则来算。每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较。
//
// 恢复与永久删除会改数据，所以各用各的删除单元。删除单元统一由**这个空间里的编辑者**删除
// （个人空间由所有者删除，那里没有别人），一行里同时考出三条规则：空间管理员可以、删除者本人可以、
// 同一个空间里的其他人不行。"删完之后被降级或被移出空间的删除者"不在这张表里（查看者与外人都不是删除者）：
// 这种情形由 documents/trash.test.ts 的恢复权限用例覆盖，判断之后、取锁之前才变的由那里的并发用例覆盖（M2-P6 复验 R-S2）。
// 两个只凭授权的人（最后两列，M2-P5 S4）：删除单元里的文档上同样有他们的授权，但回收站只看空间角色——授权不给回收站开口子，
// 两列逐格与外人（outsider）那一列相同。
//
// 搜索是范围类的操作：谁调用都是 200，真正的判定是"在结果里看到哪几份文档"，状态码表达不了，
// 所以单列一张表（矩阵之外），见本文件末尾的 describe：结果恰好是能读到的那几份（凭授权命中的不带文件夹与路径），
// 按空间列出只看空间角色（不并上授权）。
// 回收站列表与按空间列出的成功格子另外核对列出来的东西：恰好是这个空间里的，别处的一条也没有（M2-P6 复核 B 的 S-1）。
import type { SearchResult } from '@nerve-office/contracts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { ActorName, CellOptions, MatrixOperation, MatrixTable, MatrixWorld, TargetName } from './matrix-world.ts'
import { DOCUMENT_LIST_ALL_FOLDERS, DOCUMENT_LIST_MAX_LIMIT, documentListResponseSchema, searchResponseSchema, trashListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser } from '../support/session-client.ts'
import { accessViaOf, ACTORS, buildMatrixWorld, cellsOf, closeWorld, expectCell, MATRIX_TITLE_PREFIX, TARGETS } from './matrix-world.ts'

let database: TestDatabase
let app: TestApp
let world: MatrixWorld

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  world = await buildMatrixWorld(database, app)
})

afterAll(async () => {
  await closeWorld(world)
  await app.close()
  await database.drop()
})

type Operation = 'listTrash' | 'restore' | 'purge'

const MATRIX: MatrixTable<Operation> = {
  // 看得到空间内容的人都看得到回收站的列表（标题在删除之前他本来就看得到，spec §5）：与按空间列出文档同一条规则
  listTrash: {
    personal: [200, 404, 404, 404, 404, 404, 404, 404],
    team: [404, 200, 200, 200, 404, 404, 404, 404],
    visible: [200, 200, 200, 200, 200, 200, 200, 200],
    archived: [404, 200, 200, 200, 404, 404, 404, 404],
    archivedVisible: [200, 200, 200, 200, 200, 200, 200, 200],
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  },
  // 恢复（spec §3）：删除者本人（这里是编辑者）或当前的空间管理员；同空间的其他人 403；归档的空间里谁都不能
  restore: {
    personal: [200, 404, 404, 404, 404, 404, 404, 404],
    team: [404, 200, 200, 403, 404, 404, 404, 404],
    visible: [403, 200, 200, 403, 403, 403, 403, 403],
    // 归档之后删除者本人（editor 这一列）也不能恢复：有效角色至多是查看者，spec §3 另显式排除归档
    archived: [404, 403, 403, 403, 404, 404, 404, 404],
    archivedVisible: [403, 403, 403, 403, 403, 403, 403, 403],
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  },
  // 永久删除（spec §4）：只有空间管理员 / 个人空间的所有者；删除者本人（editor 这一列）也不行
  purge: {
    personal: [204, 404, 404, 404, 404, 404, 404, 404],
    team: [404, 204, 403, 403, 404, 404, 404, 404],
    visible: [403, 204, 403, 403, 403, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404, 404, 404],
    archivedVisible: [403, 403, 403, 403, 403, 403, 403, 403],
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  },
}

/** 删除单元是谁删的：个人空间里只有所有者，团队空间里用编辑者（他删自己创建的文档，spec §2 允许） */
function deleterOf(target: TargetName): string {
  return target === 'personal' ? world.actors.owner.id : world.actors.editor.id
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  listTrash: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/trash?spaceId=${world.spaces[target]}`),
  restore: async (actor, target) => {
    const entry = await world.freshTrashEntry(target, deleterOf(target))
    return asUser(app.baseUrl, actor.session, `/api/trash/${entry.id}/restore`, { method: 'POST' })
  },
  purge: async (actor, target) => {
    const entry = await world.freshTrashEntry(target, deleterOf(target))
    return asUser(app.baseUrl, actor.session, `/api/trash/${entry.id}`, { method: 'DELETE' })
  },
}

/** 成功的格子另外核对内容的操作 */
const VERIFY: Partial<Record<Operation, CellOptions['verify']>> = {
  // 回收站列表：恰好是这个空间里的删除单元（查库得到），别的空间里的一条也没有；固定的那两条（一份文档、一个文件夹）都在
  listTrash: async (response, target) => {
    const listed = parseExact(trashListResponseSchema, await response.json())
    expect(listed.nextCursor).toBeNull()
    expect(listed.items.map(item => item.id).toSorted()).toEqual(await world.trashEntryIds(target))
    expect(listed.items.map(item => item.title)).toEqual(expect.arrayContaining([`${MATRIX_TITLE_PREFIX}${target} 已删`, `矩阵已删目录：${target}`]))
  },
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：回收站', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, { verify: VERIFY[cell.operation] })
  })
})

interface ScopeCell {
  readonly target: TargetName
  readonly actor: ActorName
}

const SCOPE_CELLS: ScopeCell[] = TARGETS.flatMap(target => ACTORS.map(actor => ({ target, actor })))

/** 搜到的东西：关键词只匹配固定的那几批文档（每一格另建的文档都不带这个前缀），结果因此是确定的 */
async function searchAs(actor: ActorName): Promise<SearchResult[]> {
  const response = await asUser(app.baseUrl, world.actors[actor].session, `/api/search?query=${encodeURIComponent(MATRIX_TITLE_PREFIX)}`)
  expect(response.status, await response.clone().text()).toBe(200)
  const page = parseExact(searchResponseSchema, await response.json())
  expect(page.nextCursor).toBeNull()
  return page.items
}

/**
 * 搜索的范围（M2-P4 设计 §3.4 第 5 条、§3.5；M2-P5 设计 §3.4(2)）：能读到就搜得到——"我能看到的空间"与"我有单独授权的文档"两半，
 * 预期由 ACCESS_VIA 那一格推出（不是 null 就搜得到；凭什么看到的就是结果里的途径）。回收站里的谁都搜不到，有授权也一样。
 * 按空间列出不同：只看空间角色（ACCESS_VIA 是 space），不并上授权
 */
describe('US-M2-12 搜索与按空间列出的范围：能读到才搜得到，按空间列出只看空间角色，回收站里的谁都看不到', () => {
  // 每个目标空间里带前缀的两份（根目录下的、文件夹里的）：读得到就恰好是这两份，读不到就一份也没有；
  // 凭授权命中的不带文件夹与路径（只凭授权的人看不到空间的目录结构），凭空间角色的照常带
  it.each(SCOPE_CELLS)('US-M2-14 search：$actor 搜 $target 里的文档', async (cell) => {
    const via = accessViaOf(cell.actor, cell.target)
    const items = await searchAs(cell.actor)
    const inTarget = items.filter(item => item.space.id === world.spaces[cell.target])
    if (via === null) {
      expect(inTarget).toEqual([])
      return
    }
    const atRoot = world.documents[cell.target].id
    const inFolder = world.folderDocuments[cell.target].id
    expect(inTarget.map(item => item.id).toSorted()).toEqual([atRoot, inFolder].toSorted())
    for (const item of inTarget) {
      expect(item.accessVia, item.title).toBe(via)
      expect(item.space.type).toBe(cell.target === 'personal' ? 'personal' : 'team')
    }
    const folder = world.folders[cell.target]
    expect(inTarget.find(item => item.id === atRoot)).toMatchObject({ folderId: null, folderPath: [] })
    expect(inTarget.find(item => item.id === inFolder)).toMatchObject(via === 'grant' ? { folderId: null, folderPath: [] } : { folderId: folder.id, folderPath: [folder.name] })
    // 回收站里的那一份标题同样带前缀、同样有两个只凭授权的人的授权，但谁都搜不到（spec §5）
    expect(items.map(item => item.id)).not.toContain(world.trashedDocuments[cell.target].id)
  })

  // 整个结果恰好是能读到的那几个空间里的那几份：别处的一份也没有（例如可访问文档的条件漏了"正常状态"或者"这个人"）
  it.each(ACTORS)('US-M2-14 search：%s 搜到的恰好是能读到的那几份', async (actor) => {
    const expected = TARGETS.filter(target => accessViaOf(actor, target) !== null)
      .flatMap(target => [world.documents[target].id, world.folderDocuments[target].id])
    expect((await searchAs(actor)).map(item => item.id).toSorted()).toEqual(expected.toSorted())
  })

  // 按空间列出整个空间：没有空间角色的人是 404（只凭授权也一样），有的人看得到那份文档，但看不到回收站里的（spec §5）；
  // 列出来的恰好是这个空间里正常状态的文档（查库得到），别的空间里的一份也没有（M2-P6 复核 B 的 S-1）
  it.each(SCOPE_CELLS)('US-M2-14 listSpace：$actor 列 $target 整个空间', async (cell) => {
    const actor = world.actors[cell.actor]
    const query = new URLSearchParams({ spaceId: world.spaces[cell.target], folderId: DOCUMENT_LIST_ALL_FOLDERS, limit: String(DOCUMENT_LIST_MAX_LIMIT) })
    const response = await asUser(app.baseUrl, actor.session, `/api/documents?${query.toString()}`)
    if (accessViaOf(cell.actor, cell.target) !== 'space') {
      expect(response.status, await response.clone().text()).toBe(404)
      return
    }
    expect(response.status, await response.clone().text()).toBe(200)
    const listed = parseExact(documentListResponseSchema, await response.json())
    expect(listed.nextCursor).toBeNull()
    const ids = listed.items.map(item => item.id)
    expect(ids).toContain(world.documents[cell.target].id)
    // 整个空间：子文件夹里的也列出来（M2-P6 复验 R-G5）
    expect(ids).toContain(world.folderDocuments[cell.target].id)
    expect(ids).not.toContain(world.trashedDocuments[cell.target].id)
    expect(ids.toSorted()).toEqual(await world.activeDocumentIds(cell.target))
  })
})
