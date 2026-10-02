// 按标题搜索我能访问的文档（M2-P4 设计 §3.2、§3.4 第 5 条、§3.5，US-M2-12）：
// 大小写不敏感；关键词里的 %、_、\ 都当字面量（ESCAPE 子句）；回收站里的不出现，恢复之后又能搜到；
// 看不到的空间（团队空间的非成员、别人的个人空间）里的一律不出现，响应里也没有那些空间的任何信息；
// 归档的空间里的能搜到（归档只是只读）；结果带空间与文件夹路径（根目录是空数组，深层按顺序）；
// 分页的游标；关键词为空或全是空白 400。
// 范围的回归（M2-P6 复核 A 的 S3）：仓储直接核对"只查给定的空间"；看不到的匹配超过一页时，分页不透露它们的存在与数量。
import type { Folder, SearchResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { DocumentsRepository } from '@nerve-office/api/testing'
import { createdFolderSchema, errorResponseSchema, SEARCH_PAGE_SIZE, searchResponseSchema, trashListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { createDocument, seedDocument } from '../support/documents.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let amySession: LoggedIn
let benSession: LoggedIn

/** 艾米看得到的空间 */
let openSpace: string
let archivedSpace: string
/** 只有本是成员：艾米看不到 */
let closedSpace: string
const CLOSED_SPACE_NAME = '机要处'
/** openSpace 里的 资料 / 2026 */
let materials: Folder
let year: Folder

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  ben = await createAccount(database, { username: 'ben', displayName: '本' })
  amySession = await login(app.baseUrl, 'amy', amy.password)
  benSession = await login(app.baseUrl, 'ben', ben.password)

  openSpace = await createTeamSpace(database, { name: '市场部', createdBy: root.id, members: { [amy.id]: 'editor', [ben.id]: 'viewer' } })
  closedSpace = await createTeamSpace(database, { name: CLOSED_SPACE_NAME, createdBy: root.id, members: { [ben.id]: 'editor' } })
  archivedSpace = await createTeamSpace(database, { name: '旧项目', createdBy: root.id, members: { [amy.id]: 'editor' }, status: 'archived' })

  materials = await createFolder(openSpace, '资料')
  year = await createFolder(openSpace, '2026', materials.id)

  // 关键词"预算"的一组：范围的用例按它核对
  await seed(amy.personalSpaceId, amy.id, '季度预算表')
  await seed(openSpace, amy.id, '团队预算')
  await seed(openSpace, amy.id, '部门预算', year.id)
  await seed(archivedSpace, amy.id, '归档预算')
  await seed(closedSpace, ben.id, '机密预算')
  await seed(ben.personalSpaceId, ben.id, '本人预算')
  // 经接口删掉，放进回收站：范围的用例据此核对"回收站里的不出现"
  const trashed = await seed(amy.personalSpaceId, amy.id, '回收站里的预算')
  const deleted = await asUser(app.baseUrl, amySession, `/api/documents/${trashed}`, { method: 'DELETE' })
  if (deleted.status !== 204)
    throw new Error(`准备回收站里的文档失败：${deleted.status}`)

  // 大小写与通配符的一组：都在艾米的个人空间里
  for (const title of ['Budget Q3', 'budget q4', '100%达成', '100X达成', 'a_b 报表', 'aXb 报表', 'C:\\临时', 'C:临时'])
    await seed(amy.personalSpaceId, amy.id, title)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function seed(spaceId: string, createdBy: string, title: string, folderId?: string): Promise<string> {
  return createDocument(database, { spaceId, createdBy, title, folderId })
}

async function createFolder(spaceId: string, name: string, parentId?: string): Promise<Folder> {
  const response = await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId, name, parentId, requestId: randomUUID() } })
  expect(response.status, name).toBe(201)
  return parseExact(createdFolderSchema, await response.json())
}

async function search(user: LoggedIn, query: string, cursor?: string): Promise<SearchResponse> {
  const response = await searchResponse(user, query, cursor)
  expect(response.status, query).toBe(200)
  return parseExact(searchResponseSchema, await response.json())
}

async function searchResponse(user: LoggedIn, query: string, cursor?: string): Promise<Response> {
  const suffix = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`
  return asUser(app.baseUrl, user, `/api/search?query=${encodeURIComponent(query)}${suffix}`)
}

async function titlesOf(user: LoggedIn, query: string): Promise<string[]> {
  return (await search(user, query)).items.map(item => item.title).toSorted()
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

describe('US-M2-12 搜索的范围', () => {
  it('只搜我能看到的空间里正常状态的文档：看不到的空间与回收站里的都不出现', async () => {
    expect(await titlesOf(amySession, '预算')).toEqual(['团队预算', '季度预算表', '归档预算', '部门预算'].toSorted())
  })

  it('响应里不带看不到的空间的任何信息（空间 id、空间名、里面的标题都没有）', async () => {
    const response = await searchResponse(amySession, '预算')
    const body = await response.text()
    for (const secret of [closedSpace, CLOSED_SPACE_NAME, '机密预算', ben.personalSpaceId, '本人预算', '回收站里的预算'])
      expect(body, secret).not.toContain(secret)
  })

  it('归档的空间里的能搜到（归档只是只读）', async () => {
    const found = (await search(amySession, '归档预算')).items
    expect(found.map(item => item.space.id)).toEqual([archivedSpace])
  })

  it('换一个人搜，范围跟着他的空间走：本看得到自己的个人空间与他所在的团队空间', async () => {
    expect(await titlesOf(benSession, '预算')).toEqual(['团队预算', '机密预算', '本人预算', '部门预算'].toSorted())
  })

  it('删除之后搜不到，恢复之后又搜到', async () => {
    const title = '会消失的表'
    const document = await seed(amy.personalSpaceId, amy.id, title)
    expect(await titlesOf(amySession, title)).toEqual([title])

    const deleted = await asUser(app.baseUrl, amySession, `/api/documents/${document}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect(await titlesOf(amySession, title)).toEqual([])

    const trash = await asUser(app.baseUrl, amySession, `/api/trash?spaceId=${amy.personalSpaceId}`)
    const entry = parseExact(trashListResponseSchema, await trash.json()).items.find(item => item.title === title)
    const restored = await asUser(app.baseUrl, amySession, `/api/trash/${entry?.id ?? ''}/restore`, { method: 'POST' })
    expect(restored.status).toBe(200)
    expect(await titlesOf(amySession, title)).toEqual([title])
  })
})

describe('US-M2-12 关键词的匹配', () => {
  it('标题里包含就算，不区分大小写', async () => {
    expect(await titlesOf(amySession, 'BUDGET')).toEqual(['Budget Q3', 'budget q4'])
    expect(await titlesOf(amySession, 'budget')).toEqual(['Budget Q3', 'budget q4'])
    expect(await titlesOf(amySession, 'Q3')).toEqual(['Budget Q3'])
    // 只是标题中间的一段也算
    expect(await titlesOf(amySession, 'et q4')).toEqual(['budget q4'])
  })

  it('关键词里的 % 是字面量，不是"任意多个字符"', async () => {
    expect(await titlesOf(amySession, '100%')).toEqual(['100%达成'])
    expect(await titlesOf(amySession, '%')).toEqual(['100%达成'])
  })

  it('关键词里的 _ 是字面量，不是"任意一个字符"', async () => {
    expect(await titlesOf(amySession, 'a_b')).toEqual(['a_b 报表'])
    expect(await titlesOf(amySession, '_')).toEqual(['a_b 报表'])
  })

  it('关键词里的反斜杠是字面量，不是转义符', async () => {
    expect(await titlesOf(amySession, 'C:\\临时')).toEqual(['C:\\临时'])
    expect(await titlesOf(amySession, '\\')).toEqual(['C:\\临时'])
    // 没有反斜杠的那一份只能用没有反斜杠的关键词搜到
    expect(await titlesOf(amySession, 'C:临时')).toEqual(['C:临时'])
  })

  it('不区分大小写对非 ASCII 的字母同样成立：带变音符的拉丁字母、希腊字母、西里尔字母（M2-P6 复核 B 的 G-7）', async () => {
    for (const title of ['\u00C4rzte \u00DCbersicht', '\u03A3\u039F\u03A6\u0399\u0391 \u03C3\u03C7\u03AD\u03B4\u03B9\u03BF', '\u041C\u041E\u0421\u041A\u0412\u0410 \u043E\u0442\u0447\u0451\u0442'])
      await seed(amy.personalSpaceId, amy.id, title)
    expect(await titlesOf(amySession, '\u00E4rzte')).toEqual(['\u00C4rzte \u00DCbersicht'])
    expect(await titlesOf(amySession, '\u00DCBERSICHT')).toEqual(['\u00C4rzte \u00DCbersicht'])
    expect(await titlesOf(amySession, '\u03C3\u03BF\u03C6\u03B9\u03B1')).toEqual(['\u03A3\u039F\u03A6\u0399\u0391 \u03C3\u03C7\u03AD\u03B4\u03B9\u03BF'])
    expect(await titlesOf(amySession, '\u03A3\u03A7\u0388\u0394\u0399\u039F')).toEqual(['\u03A3\u039F\u03A6\u0399\u0391 \u03C3\u03C7\u03AD\u03B4\u03B9\u03BF'])
    expect(await titlesOf(amySession, '\u043C\u043E\u0441\u043A\u0432\u0430')).toEqual(['\u041C\u041E\u0421\u041A\u0412\u0410 \u043E\u0442\u0447\u0451\u0442'])
    expect(await titlesOf(amySession, '\u041E\u0422\u0427\u0401\u0422')).toEqual(['\u041C\u041E\u0421\u041A\u0412\u0410 \u043E\u0442\u0447\u0451\u0442'])
  })

  it('搜不到东西就是空列表，不是错误', async () => {
    expect(await search(amySession, '这个标题不存在')).toEqual({ items: [], nextCursor: null })
  })
})

describe('US-M2-12 搜索的范围只由仓储给出（M2-P6 复核 A 的 S3）', () => {
  it('仓储直接核对：只返回给定空间里正常状态的行，范围之外的空间、回收站里的一行也没有；多个空间时同样', async () => {
    const repository = app.runtime.get(DocumentsRepository)
    const keyword = '仓储范围'
    const inOpen = await seed(openSpace, amy.id, `${keyword} 市场部`)
    const inPersonal = await seed(amy.personalSpaceId, amy.id, `${keyword} 艾米`)
    await seed(closedSpace, ben.id, `${keyword} 机要处`)
    await seed(ben.personalSpaceId, ben.id, `${keyword} 本`)
    const trashed = await seed(openSpace, amy.id, `${keyword} 删掉的`)
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${trashed}`, { method: 'DELETE' })).status).toBe(204)

    const pattern = `%${keyword}%`
    const found = await repository.searchByTitle({ spaceIds: [openSpace, amy.personalSpaceId], grantsOf: undefined }, { limit: 100, titlePattern: pattern })
    expect(found.map(row => row.id).toSorted()).toEqual([inOpen, inPersonal].toSorted())
    expect(new Set(found.map(row => row.spaceId))).toEqual(new Set([openSpace, amy.personalSpaceId]))
    expect((await repository.searchByTitle({ spaceIds: [openSpace], grantsOf: undefined }, { limit: 100, titlePattern: pattern })).map(row => row.id)).toEqual([inOpen])
    expect(await repository.searchByTitle({ spaceIds: [], grantsOf: undefined }, { limit: 100, titlePattern: pattern })).toEqual([])
    // 列表用的是同一个"可访问文档"的条件
    const listed = await repository.listAccessible({ spaceIds: [openSpace, amy.personalSpaceId], grantsOf: undefined }, { limit: 100 })
    expect(listed.every(row => row.spaceId === openSpace || row.spaceId === amy.personalSpaceId)).toBe(true)
    expect(listed.map(row => row.id)).toEqual(expect.arrayContaining([inOpen, inPersonal]))
    expect(listed.map(row => row.id)).not.toContain(trashed)
  })

  it('看不到的匹配超过一页：结果只有自己的那一份，没有下一页的游标（分页不透露看不到的文档）', async () => {
    // 外人另外是一个团队空间的查看者：他看得到的空间不止一个（搜索的范围是多个空间的集合）
    const owner = await createAccount(database, { username: 'leak-owner' })
    const outsider = await createAccount(database, { username: 'leak-outsider' })
    const outsiderSession = await login(app.baseUrl, outsider.username, outsider.password)
    await createTeamSpace(database, { name: '外人所在的团队', createdBy: root.id, members: { [outsider.id]: 'viewer' } })
    for (let index = 0; index <= SEARCH_PAGE_SIZE; index += 1)
      await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: `并购机密 ${index}` })
    await seedDocument(database, { spaceId: outsider.personalSpaceId, createdBy: outsider.id, title: '我的并购机密笔记', updatedAt: 'now() - interval \'1 day\'' })

    const page = await search(outsiderSession, '并购机密')
    expect(page.items.map(item => item.title)).toEqual(['我的并购机密笔记'])
    expect(page.nextCursor).toBeNull()
  })
})

describe('US-M2-12 结果里的位置', () => {
  it('带所在空间的 id、类型与名称，以及从空间根目录到它所在文件夹的名称', async () => {
    const [found] = (await search(amySession, '部门预算')).items
    expect(found).toMatchObject({
      title: '部门预算',
      type: 'sheet',
      space: { id: openSpace, type: 'team', name: '市场部' },
      folderId: year.id,
      folderPath: ['资料', '2026'],
    })
  })

  it('空间根目录下的文档：folderId 为空，路径是空数组', async () => {
    const [found] = (await search(amySession, '团队预算')).items
    expect(found).toMatchObject({ folderId: null, folderPath: [] })
  })

  it('个人空间里的文档：空间的类型是 personal，名称是本人的显示名，另带所有者（"人"的结构，M2-P5：界面按所有者的人名呈现）', async () => {
    const [found] = (await search(amySession, '季度预算表')).items
    expect(found?.space).toEqual({ id: amy.personalSpaceId, type: 'personal', name: '艾米', owner: { id: amy.id, username: 'amy', displayName: '艾米' } })
  })

  it('深层的文件夹：路径按从浅到深，每一层一段', async () => {
    let parent = await createFolder(openSpace, '深 1')
    const names = ['深 1']
    for (let level = 2; level <= 5; level += 1) {
      parent = await createFolder(openSpace, `深 ${level}`, parent.id)
      names.push(`深 ${level}`)
    }
    await seed(openSpace, amy.id, '深处的表', parent.id)
    const [found] = (await search(amySession, '深处的表')).items
    expect(found?.folderPath).toEqual(names)
  })
})

describe('US-M2-12 搜索的分页', () => {
  it('每页固定条数，按游标逐页取完，不丢也不重', async () => {
    const space = await createTeamSpace(database, { name: '分页部', createdBy: root.id, members: { [amy.id]: 'editor' } })
    const total = SEARCH_PAGE_SIZE + 2
    const created: string[] = []
    for (let index = 0; index < total; index += 1)
      created.push(await seed(space, amy.id, `分页 ${String(index).padStart(2, '0')}`))

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await search(amySession, '分页', cursor)
      expect(page.items.length, `第 ${pages + 1} 页`).toBeLessThanOrEqual(SEARCH_PAGE_SIZE)
      seen.push(...page.items.map(item => item.id))
      cursor = page.nextCursor ?? undefined
      pages += 1
    } while (cursor !== undefined && pages < 5)

    expect(pages).toBe(2)
    expect(seen).toHaveLength(total)
    expect(new Set(seen)).toEqual(new Set(created))
  })

  it('游标不合法：400 REQUEST_INVALID，不是 500', async () => {
    const response = await searchResponse(amySession, '预算', 'not-a-cursor')
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('REQUEST_INVALID')
  })
})

describe('US-M2-12 关键词的校验', () => {
  it('关键词为空、全是空白、没有给：400 REQUEST_INVALID', async () => {
    for (const query of ['', ' ', '   ', '\t', '　']) {
      const response = await searchResponse(amySession, query)
      expect(response.status, JSON.stringify(query)).toBe(400)
      expect((await errorOf(response)).code).toBe('REQUEST_INVALID')
    }
    const missing = await asUser(app.baseUrl, amySession, '/api/search')
    expect(missing.status).toBe(400)
    expect((await errorOf(missing)).code).toBe('REQUEST_INVALID')
  })

  it('关键词首尾的空白不算：与去掉空白之后的结果相同', async () => {
    expect(await titlesOf(amySession, '  团队预算  ')).toEqual(['团队预算'])
  })

  it('关键词超过标题的上限、每页条数由客户端指定：400 REQUEST_INVALID', async () => {
    const tooLong = await searchResponse(amySession, '好'.repeat(201))
    expect(tooLong.status).toBe(400)
    expect((await errorOf(tooLong)).code).toBe('REQUEST_INVALID')
    const extra = await asUser(app.baseUrl, amySession, '/api/search?query=%E9%A2%84%E7%AE%97&limit=10')
    expect(extra.status).toBe(400)
    expect((await errorOf(extra)).code).toBe('REQUEST_INVALID')
  })

  it('没有登录：401 UNAUTHENTICATED', async () => {
    const response = await fetch(`${app.baseUrl}/api/search?query=%E9%A2%84%E7%AE%97`)
    expect(response.status).toBe(401)
    expect((await errorOf(response)).code).toBe('UNAUTHENTICATED')
  })
})
