// 权限矩阵：分享（授权的列表、设置与调整、取消）与"与我共享"——M2-P5 设计 §3.2、§3.4(1)(4)，US-M2-10、US-M2-14（S4）。
// 预期逐格写在表里，不调用生产代码的规则来算。每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较（看不到与不存在一致）。
//
// 分享是结构性的操作，只看空间角色：空间管理员与个人空间的所有者能分享，归档的空间里冻结（需求方 2026-10-01 确认）。
// 403 的说明逐格钉住（S2 定的几句）：
// - 只凭授权的人（ACCESS_VIA 是 grant）："这份文档是单独分享给你的，不能再分享给别人"——编辑授权也一样，与空间归不归档无关；
// - 归档的空间里恢复之后能分享的人（归档之前是空间管理员的，世界里是 spaceAdmin 这一列）：冻结的说明"空间已归档，恢复之后才能调整分享"
//   （与归档时默认的"只能查看"不同）。这句话许诺了恢复之后的能力，只给他们（M2-P5 审查 A 的一般 6、B 的 G1）；
// - 其余（空间里的编辑者、查看者，含全员可见给的查看者，归档与否都一样）："只有空间管理员能分享这份文档"。
// 设置与取消各用一份新文档（授权会改），授权的列表只读、用固定的那一份。
//
// "与我共享"（列表类，谁调用都是 200）：每个人此刻恰好看到他有授权的、正常状态的那几份（直接查库），回收站里的有授权也不出现，
// 每个目标空间里没分享给只凭授权的人的那一份（matrix-world 的 ungrantedDocuments）同一个空间里有别的授权也不出现；
// 每一条的内容权限按授权与空间角色逐格推出（取较高者，归档降到查看者），个人空间按所有者呈现。
// 另核对每个人自己的个人空间：按空间列出与回收站里只有自己空间里的东西，分享给他的一份也不混进来。
import type { DocumentGrant, SharedDocument, SpaceRole } from '@nerve-office/contracts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { ActorName, CellOptions, MatrixCell, MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { DOCUMENT_LIST_ALL_FOLDERS, DOCUMENT_LIST_MAX_LIMIT, documentGrantListResponseSchema, documentGrantSchema, documentListResponseSchema, sharedListResponseSchema, trashListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { grantsOn, setGrant } from '../support/grants.ts'
import { asUser } from '../support/session-client.ts'
import { accessViaOf, ACTORS, buildMatrixWorld, cellsOf, closeWorld, expectCell, isArchived, TARGETS } from './matrix-world.ts'

let database: TestDatabase
let app: TestApp
let world: MatrixWorld
/** 目标空间的名称（团队空间在"与我共享"里给名称），直接查库 */
let spaceNames: ReadonlyMap<string, string>

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  world = await buildMatrixWorld(database, app)
  spaceNames = new Map(await database.query(async client => (await client.query<{ id: string, name: string }>(
    'SELECT id, name FROM spaces WHERE id = ANY($1::uuid[])',
    [Object.values(world.spaces)],
  )).rows.map(row => [row.id, row.name] as const)))
})

afterAll(async () => {
  await closeWorld(world)
  await app.close()
  await database.drop()
})

type Operation = 'listGrants' | 'setGrant' | 'removeGrant'

/**
 * 分享的权限（00 号计划书 §5.3 的分享一行，M2-P5 设计 §3.2）：空间管理员、个人空间的所有者；
 * 空间里的编辑者、查看者与全员可见给的查看者 403；只凭授权的人看得到这份文档却不能分享，403；
 * 归档的空间里有空间角色的人都 403（冻结），看不到的人仍是 404
 */
function sharerOnly(success: 200 | 204): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404, 403, 403],
    team: [404, success, 403, 403, 404, 404, 403, 403],
    visible: [403, success, 403, 403, 403, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404, 403, 403],
    archivedVisible: [403, 403, 403, 403, 403, 403, 403, 403],
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  }
}

const MATRIX: MatrixTable<Operation> = {
  // 查看授权的列表也要分享的权限（设计 §3.2：要有分享的权限才看得到谁被分享了）
  listGrants: sharerOnly(200),
  setGrant: sharerOnly(200),
  removeGrant: sharerOnly(204),
}

const FROZEN = '空间已归档，恢复之后才能调整分享'
const NOT_ADMIN = '只有空间管理员能分享这份文档'
const GRANT_ONLY = '这份文档是单独分享给你的，不能再分享给别人'

/**
 * 归档之前是空间管理员的那一列：世界里四个团队空间的空间管理员是 spaceAdmin（所有者只在个人空间里是空间管理员，个人空间不归档）。
 * 他们恢复之后能分享，归档时给冻结的说明
 */
const SHARER_ONCE_RESTORED: ActorName = 'spaceAdmin'

/**
 * 这一格 403 的说明：只凭授权的人是他自己的那一句（先于归档）；归档的空间里恢复之后能分享的人是冻结；其余是"只有空间管理员能分享"
 */
function deniedMessageOf(cell: MatrixCell<Operation>): string {
  if (accessViaOf(cell.actor, cell.target) === 'grant')
    return GRANT_ONLY
  return isArchived(cell.target) && cell.actor === SHARER_ONCE_RESTORED ? FROZEN : NOT_ADMIN
}

/** 设置人：这个空间的空间管理员（个人空间是所有者），与被授权人不是同一个人 */
function grantorOf(target: TargetName): string {
  return target === 'personal' ? world.actors.owner.id : world.actors.spaceAdmin.id
}

/** 设置与取消那两格用到的文档与被授权人（verify 据此核对库里的授权） */
let lastChange: { readonly documentId: string, readonly subject: string } | undefined

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  listGrants: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.documents[target].id}/grants`),
  setGrant: async (actor, target) => {
    const document = await world.freshDocument(target)
    // 一个与谁都无关的有效账户：被授权人的检查（不是自己、有效）对谁都成立，这一行只考核文档的那一半
    const subject = await world.freshSubject(target, false)
    lastChange = { documentId: document.id, subject }
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}/grants/${subject}`, { method: 'PUT', body: { role: 'editor' } })
  },
  removeGrant: async (actor, target) => {
    const document = await world.freshDocument(target)
    const subject = await world.freshSubject(target, false)
    if (target !== 'missing') {
      await setGrant(database, { documentId: document.id, userId: subject, role: 'viewer', grantedBy: grantorOf(target) })
      // 前提：要取消的这一条确实在库里——取消按状态幂等，什么也没删照样 204，"原来的两条不动"也照样成立（M2-P5 审查 A 的一般 5）
      expect(await storedGrants(document.id)).toHaveProperty(subject, 'viewer')
    }
    lastChange = { documentId: document.id, subject }
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}/grants/${subject}`, { method: 'DELETE' })
  },
}

/** 这份文档上的授权（被授权人 → 角色），直接查库 */
async function storedGrants(documentId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await grantsOn(database, [documentId])).map(grant => [grant.userId, grant.role]))
}

/** 两个只凭授权的人在世界里每一份文档上的那两条 */
function granteeGrants(): Record<string, string> {
  return { [world.actors.grantViewer.id]: 'viewer', [world.actors.grantEditor.id]: 'editor' }
}

/** 成功的格子另外核对内容的操作 */
const VERIFY: Partial<Record<Operation, CellOptions['verify']>> = {
  // 授权的列表：恰好是固定文档上的那两条（两个只凭授权的人，查看者与编辑者），与库里的一致
  listGrants: async (response, target) => {
    const items = parseExact(documentGrantListResponseSchema, await response.json()).items
    const listed = Object.fromEntries(items.map((grant: DocumentGrant) => [grant.user.id, grant.role]))
    expect(listed).toEqual(granteeGrants())
    expect(listed).toEqual(await storedGrants(world.documents[target].id))
  },
  // 设置：响应是这一条授权（被授权人、角色、设置人是发起请求的人）；库里多了这一条，原来的两条不动
  setGrant: async (response, _target, actor) => {
    const change = lastChange
    if (change === undefined)
      throw new Error('没有记下设置的那一格')
    const grant = parseExact(documentGrantSchema, await response.json())
    expect(grant).toMatchObject({ user: { id: change.subject }, role: 'editor', status: 'active', grantedBy: { id: world.actors[actor].id } })
    expect(await storedGrants(change.documentId)).toEqual({ ...granteeGrants(), [change.subject]: 'editor' })
  },
  // 取消：库里没有这一条了，原来的两条不动
  removeGrant: async (response) => {
    const change = lastChange
    if (change === undefined)
      throw new Error('没有记下取消的那一格')
    expect(await response.text()).toBe('')
    expect(await storedGrants(change.documentId)).toEqual(granteeGrants())
  },
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-10 权限矩阵：分享（授权的列表、设置、取消）', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, { deniedMessage: deniedMessageOf(cell), verify: VERIFY[cell.operation] })
  })
})

/**
 * "与我共享"里每一条的内容权限（M2-P5 设计 §3.4(4)）：空间角色与授权取较高者，归档的空间里至多是查看者——逐格写出：
 * 只有查看授权的人处处是查看者；只有编辑授权的人在个人空间、团队空间是编辑者（只凭授权），在全员可见的空间里也是编辑者
 * （全员可见给了查看者，授权更高），归档的两个空间里降为查看者。别的人没有授权，"与我共享"里什么也没有
 */
const SHARED_CONTENT_ROLE: Readonly<Record<TargetName, Partial<Record<ActorName, SpaceRole>>>> = {
  personal: { grantViewer: 'viewer', grantEditor: 'editor' },
  team: { grantViewer: 'viewer', grantEditor: 'editor' },
  visible: { grantViewer: 'viewer', grantEditor: 'editor' },
  archived: { grantViewer: 'viewer', grantEditor: 'viewer' },
  archivedVisible: { grantViewer: 'viewer', grantEditor: 'viewer' },
  missing: {},
}

/** 这个人的"与我共享"，按游标取完所有页（另建的文档会让两个只凭授权的人超过一页） */
async function sharedWithMe(actor: ActorName): Promise<SharedDocument[]> {
  const items: SharedDocument[] = []
  let cursor: string | null = null
  do {
    const query: string = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
    const response = await asUser(app.baseUrl, world.actors[actor].session, `/api/shared${query}`)
    expect(response.status, await response.clone().text()).toBe(200)
    const page = parseExact(sharedListResponseSchema, await response.json())
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== null)
  return items
}

interface ScopeCell {
  readonly target: TargetName
  readonly actor: ActorName
}

const SCOPE_CELLS: ScopeCell[] = TARGETS.flatMap(target => ACTORS.map(actor => ({ target, actor })))

describe('US-M2-10 "与我共享"：恰好是我有授权的那几份，内容权限取较高者、归档降到查看者', () => {
  it.each(SCOPE_CELLS)('US-M2-14 sharedWithMe：$actor 在 $target 里', async (cell) => {
    const role = SHARED_CONTENT_ROLE[cell.target][cell.actor]
    const expected = await world.grantedDocumentIds(world.actors[cell.actor].id, cell.target)
    const ungranted = world.ungrantedDocuments[cell.target].id
    // 前提：库里的授权与世界的摆法一致——有授权的人在这个空间的固定文档上确实有授权（回收站里的那份不算），别人一条也没有；
    // 没分享给他们的那一份上谁的授权也没有
    if (role === undefined) {
      expect(expected).toEqual([])
    }
    else {
      expect(expected).toEqual(expect.arrayContaining([world.documents[cell.target].id, world.folderDocuments[cell.target].id]))
      expect(expected).not.toContain(world.trashedDocuments[cell.target].id)
    }
    expect(expected).not.toContain(ungranted)
    const listed = await sharedWithMe(cell.actor)
    const inTarget = listed.filter(item => item.space.id === world.spaces[cell.target])
    expect(inTarget.map(item => item.id).toSorted()).toEqual(expected)
    // 同一个空间里别的文档分享给了他，没分享的那一份也不能顺带出现（"授权那一半"要关联到这份文档，M2-P5 审查 B 的 S2）
    expect(listed.map(item => item.id)).not.toContain(ungranted)
    for (const item of inTarget) {
      expect(item.contentRole, item.title).toBe(role)
      // 所在的空间：团队空间是名称，个人空间是所有者（不给存的名称：parseExact 已核对没有多出的字段）
      expect(item.space).toEqual(cell.target === 'personal'
        ? { id: world.spaces.personal, type: 'personal', owner: { id: world.actors.owner.id, username: 'matrix-owner', displayName: 'matrix-owner' } }
        : { id: world.spaces[cell.target], type: 'team', name: spaceNames.get(world.spaces[cell.target]) })
    }
  })

  // 整个列表恰好是库里我有授权的、正常状态的那些（跨空间的那一端里另建的也算），别的一份也没有
  it.each(ACTORS)('US-M2-14 sharedWithMe：%s 的整个列表', async (actor) => {
    const expected = await world.grantedDocumentIds(world.actors[actor].id)
    const listed = (await sharedWithMe(actor)).map(item => item.id)
    expect(listed.toSorted()).toEqual(expected)
    for (const target of TARGETS)
      expect(listed, target).not.toContain(world.ungrantedDocuments[target].id)
    if (!(actor === 'grantViewer' || actor === 'grantEditor'))
      expect(expected).toEqual([])
  })
})

describe('US-M2-14 自己的个人空间：按空间列出与回收站里只有自己空间里的东西，分享给我的一份也不混进来', () => {
  it.each(ACTORS)('US-M2-14 ownSpace：%s', async (actor) => {
    const { session } = world.actors[actor]
    const spaceId = session.session.personalSpace.id
    const query = new URLSearchParams({ spaceId, folderId: DOCUMENT_LIST_ALL_FOLDERS, limit: String(DOCUMENT_LIST_MAX_LIMIT) })
    const listed = parseExact(documentListResponseSchema, await (await asUser(app.baseUrl, session, `/api/documents?${query.toString()}`)).json())
    const trash = parseExact(trashListResponseSchema, await (await asUser(app.baseUrl, session, `/api/trash?spaceId=${spaceId}`)).json())
    const stored = await database.query(async client => ({
      documents: (await client.query<{ id: string }>('SELECT id FROM documents WHERE space_id = $1 AND status = \'active\' ORDER BY id', [spaceId])).rows.map(row => row.id),
      entries: (await client.query<{ id: string }>('SELECT id FROM trash_entries WHERE space_id = $1 ORDER BY id', [spaceId])).rows.map(row => row.id),
    }))
    expect(listed.nextCursor).toBeNull()
    expect(listed.items.map(item => item.id).toSorted()).toEqual(stored.documents)
    expect(trash.items.map(item => item.id).toSorted()).toEqual(stored.entries)
    // 前提：两个只凭授权的人自己的空间里什么也没有，而他们有授权的文档不少——列出来的若不是空的，就是授权混进来了
    if (actor === 'grantViewer' || actor === 'grantEditor') {
      expect(stored).toEqual({ documents: [], entries: [] })
      expect((await world.grantedDocumentIds(world.actors[actor].id)).length).toBeGreaterThan(0)
    }
  })
})
