// 另存为副本（M3-P2 设计 §3.2，00 号计划书 §7.5；US-M3-11、12、13 的服务端部分）：失去编辑权、还读得到原文档的人，
// 把本页的内容（上传的快照）存成一份新文档。经真实的应用与数据库核对：
// - 只要求能读原文档：查看者、只凭授权的人、归档空间里的人都能，读不到的与不存在的一样 404；
// - 放在哪里：本人在原文档所在的空间有新建权限时放进原文档所在的文件夹，否则本人个人空间的根目录；
// - 新文档的各列（unitId 与原文档相同、类型档案格式照原文档、SDK 版本是平台内置的、修订号 1、代次 0、修订记录 created）、
//   内容是上传的字节、不继承授权、审计；
// - 正文的读取与保存相同（内容类型、单个完整的 gzip 成员、5 MiB 的上限）、快照的基本校验与 unitId；
// - requestId 幂等（重放、并发、冲突），放在哪里不算进摘要；
// - 锁下重新判断（确定交错，support/held-lock.ts）：取锁之前被降级、移出、取消授权，原文档在空间内换了文件夹；另存持锁时降级等它提交。
// 看不到与不存在的语句序列在 permissions/hidden-missing-parity.test.ts，逐格的权限与放置在 permissions/conflict-copy-matrix.test.ts。
import type { CreatedDocument } from '@nerve-office/contracts'
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { conflictCopyTitle, createdDocumentSchema, CSRF_TOKEN_HEADER, documentDetailSchema, errorResponseSchema, SNAPSHOT_MAX_RAW_BYTES, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { CONFLICT_COPY_LABEL, conflictCopyPath, pageSnapshot, postConflictCopy } from '../support/conflict-copies.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { grantsOn, setGrants } from '../support/grants.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setMember } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 系统管理员（建团队空间）；团队空间的空间管理员、编辑者、查看者；只有查看授权、只有编辑授权的人；外人 */
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let vic: TestAccount
let gil: TestAccount
let gwen: TestAccount
let outsider: TestAccount
const sessions = new Map<string, LoggedIn>()
let spaces = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'copy-root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'copy-amy', displayName: '艾米' })
  ben = await createAccount(database, { username: 'copy-ben', displayName: '本' })
  vic = await createAccount(database, { username: 'copy-vic', displayName: '维克' })
  gil = await createAccount(database, { username: 'copy-gil', displayName: '吉尔' })
  gwen = await createAccount(database, { username: 'copy-gwen', displayName: '格温' })
  outsider = await createAccount(database, { username: 'copy-outsider' })
  for (const account of [root, amy, ben, vic, gil, gwen, outsider])
    sessions.set(account.id, await login(app.baseUrl, account.username, account.password))
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

function sessionOf(account: TestAccount): LoggedIn {
  const session = sessions.get(account.id)
  if (session === undefined)
    throw new Error(`${account.username} 没有登录`)
  return session
}

/** 一个新的团队空间：艾米是空间管理员、本是编辑者、维克是查看者（会改成员的用例各用各的空间） */
async function teamSpace(options: { readonly status?: 'active' | 'archived', readonly visibleToAll?: boolean } = {}): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: `副本 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin', [ben.id]: 'editor', [vic.id]: 'viewer' }, ...options })
}

/** 团队空间里一个正常状态的文件夹（直接写库，与经接口新建的一致） */
async function folderIn(spaceId: string, name = '资料'): Promise<string> {
  return database.query(async (client) => {
    const id = (await client.query<{ id: string }>(
      'INSERT INTO folders (space_id, parent_id, name, created_by, depth, request_id, payload_digest) VALUES ($1, NULL, $2, $3, 1, $4, sha256(\'\'::bytea)) RETURNING id',
      [spaceId, name, amy.id, randomUUID()],
    )).rows[0]?.id
    if (id === undefined)
      throw new Error('建文件夹没有返回 id')
    return id
  })
}

/** 原文档：艾米建在团队空间里（可以放在文件夹里），吉尔有查看授权、格温有编辑授权 */
async function sourceIn(spaceId: string, folderId?: string): Promise<SeededDocument> {
  const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报', ...(folderId === undefined ? {} : { folderId }) })
  await setGrants(database, [
    { documentId: document.id, userId: gil.id, role: 'viewer', grantedBy: amy.id },
    { documentId: document.id, userId: gwen.id, role: 'editor', grantedBy: amy.id },
  ])
  return document
}

const TITLE = conflictCopyTitle('周报', CONFLICT_COPY_LABEL)

async function copyOf(response: Response): Promise<CreatedDocument> {
  expect(response.status, await response.clone().text()).toBe(201)
  return parseExact(createdDocumentSchema, await response.json())
}

/** 错误码与说明（请求标识每次不同，不比较） */
async function errorOf(response: Response): Promise<{ status: number, code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { status: response.status, code, message }
}

interface StoredCopy {
  readonly space_id: string
  readonly folder_id: string | null
  readonly title: string
  readonly type: string
  readonly created_by: string
  readonly status: string
  readonly revision: number
  readonly write_epoch: number
  readonly unit_id: string
  readonly profile: string
  readonly format_version: number
  readonly sdk_version: string
  readonly snapshot: Buffer
  readonly raw_bytes: number
}

async function stored(id: string): Promise<StoredCopy> {
  const row = await database.query(async client => (await client.query<StoredCopy>(
    `SELECT d.space_id, d.folder_id, d.title, d.type, d.created_by, d.status, d.revision, d.write_epoch, d.unit_id, d.profile, d.format_version, d.sdk_version,
            c.snapshot, c.raw_bytes
     FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1`,
    [id],
  )).rows[0])
  if (row === undefined)
    throw new Error(`没有文档 ${id}`)
  return row
}

/** 这份原文档的副本（按审计找）：另存为副本的对象是副本，明细带原文档 */
async function copiesOf(sourceId: string): Promise<{ readonly targetId: string, readonly actorId: string, readonly details: Record<string, unknown> }[]> {
  return database.query(async client => (await client.query<{ targetId: string, actorId: string, details: Record<string, unknown> }>(
    `SELECT target_id AS "targetId", actor_id AS "actorId", details FROM audit_events
     WHERE action = 'documents.conflict_copied' AND details->>'sourceId' = $1 ORDER BY occurred_at, id`,
    [sourceId],
  )).rows)
}

async function documentCount(): Promise<number> {
  return database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM documents')).rows[0]?.count ?? 0)
}

describe('US-M3-11 另存为副本：放在哪里与新文档', () => {
  it('US-M3-11 能在原文档所在的空间新建（编辑者）：201，放进原文档所在的文件夹；新的一份文档——unitId 与原文档相同，类型、档案、格式版本照原文档，SDK 版本是平台内置的，修订号 1、代次 0，修订记录 created；内容就是上传的字节；审计；原文档不动', async () => {
    const space = await teamSpace()
    const folder = await folderIn(space)
    const source = await sourceIn(space, folder)
    // 原文档写入时的 SDK 版本是旧的、有过几代编辑权：副本是新文档，SDK 版本是平台内置的，代次从 0 开始
    await database.query(async client => client.query('UPDATE documents SET sdk_version = \'0.9.9\', write_epoch = 4 WHERE id = $1', [source.id]))
    const before = await stored(source.id)
    const raw = pageSnapshot(source.unitId, '本页没保存上的修改')
    const gzipped = zlib.gzipSync(raw)
    const requestId = randomUUID()
    const copy = await copyOf(await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId, title: TITLE, bytes: gzipped }))

    expect(copy).toMatchObject({ title: TITLE, spaceId: space, folderId: folder, accessVia: 'space', revision: 1, type: 'sheet', profile: 'sheet@1', formatVersion: 1, replayed: false })
    expect([copy.space.id, copy.space.type]).toEqual([space, 'team'])
    expect(copy.permissions).toMatchObject({ canEdit: true, canRename: true, canCopy: true })
    expect(copy.id).not.toBe(source.id)
    const row = await stored(copy.id)
    expect(row).toMatchObject({
      space_id: space,
      folder_id: folder,
      title: TITLE,
      type: 'sheet',
      created_by: ben.id,
      status: 'active',
      revision: 1,
      write_epoch: 0,
      unit_id: source.unitId,
      profile: before.profile,
      format_version: before.format_version,
      sdk_version: UNIVER_SDK_VERSION,
      raw_bytes: raw.length,
    })
    // 上传的压缩字节原样存下（与保存一样），读取副本得到本页的内容
    expect(row.snapshot.equals(gzipped)).toBe(true)
    const content = await asUser(app.baseUrl, sessionOf(ben), `/api/documents/${copy.id}/content`)
    expect([content.status, content.headers.get('etag')]).toEqual([200, '"1"'])
    expect(await content.text()).toBe(raw.toString('utf8'))
    const revisions = await database.query(async client => (await client.query<Record<string, unknown>>(
      'SELECT revision, kind, request_id, client_instance_id, local_seq, saved_by FROM document_revisions WHERE document_id = $1',
      [copy.id],
    )).rows)
    expect(revisions).toEqual([{ revision: 1, kind: 'created', request_id: requestId, client_instance_id: null, local_seq: null, saved_by: ben.id }])
    expect(await copiesOf(source.id)).toEqual([{ targetId: copy.id, actorId: ben.id, details: { sourceId: source.id, spaceId: space } }])
    // 原文档一点不动（修订号、内容、代次）
    expect(await stored(source.id)).toEqual(before)
  })

  it('原文档在空间的根目录：副本也在根目录；空间管理员同样放进原文档所在的空间', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const copy = await copyOf(await postConflictCopy(app.baseUrl, sessionOf(amy), source.id, source.unitId))
    expect([copy.spaceId, copy.folderId]).toEqual([space, null])
  })

  it('原文档在自己的个人空间的文件夹里：副本放进那个文件夹', async () => {
    const folder = await folderIn(outsider.personalSpaceId)
    const source = await seedDocument(database, { spaceId: outsider.personalSpaceId, createdBy: outsider.id, title: '草稿', folderId: folder })
    const copy = await copyOf(await postConflictCopy(app.baseUrl, sessionOf(outsider), source.id, source.unitId))
    expect([copy.spaceId, copy.folderId, copy.space]).toEqual([outsider.personalSpaceId, folder, { id: outsider.personalSpaceId, type: 'personal' }])
  })

  it.each([
    ['空间里的查看者', () => vic, {}],
    ['归档的空间里的编辑者', () => ben, { status: 'archived' as const }],
    ['全员可见的空间里不是成员的人', () => outsider, { visibleToAll: true }],
    ['只有查看授权的人', () => gil, {}],
    ['只有编辑授权的人', () => gwen, {}],
  ])('US-M3-12 能读、不能在原文档所在的空间新建（%s）：放进本人个人空间的根目录', async (_name, who, options) => {
    const space = await teamSpace(options)
    const folder = await folderIn(space)
    const source = await sourceIn(space, folder)
    const account = who()
    const copy = await copyOf(await postConflictCopy(app.baseUrl, sessionOf(account), source.id, source.unitId))
    expect(copy).toMatchObject({ spaceId: account.personalSpaceId, folderId: null, space: { id: account.personalSpaceId, type: 'personal' }, accessVia: 'space' })
    expect(copy.permissions).toMatchObject({ canEdit: true, canShare: true })
    expect(await stored(copy.id)).toMatchObject({ space_id: account.personalSpaceId, folder_id: null, unit_id: source.unitId, created_by: account.id })
    expect((await copiesOf(source.id)).map(row => row.details)).toEqual([{ sourceId: source.id, spaceId: account.personalSpaceId }])
  })

  it('US-M3-12 副本不继承原文档的单独授权：副本上没有授权，原文档的被授权人看不到副本（404，与不存在的相同）', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const copy = await copyOf(await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId))
    expect(await grantsOn(database, [copy.id])).toEqual([])
    expect((await grantsOn(database, [source.id])).map(grant => grant.userId).toSorted()).toEqual([gil.id, gwen.id].toSorted())
    for (const grantee of [gil, gwen]) {
      const hidden = await asUser(app.baseUrl, sessionOf(grantee), `/api/documents/${copy.id}`)
      const missing = await asUser(app.baseUrl, sessionOf(grantee), `/api/documents/${randomUUID()}`)
      expect(await errorOf(hidden), grantee.username).toEqual(await errorOf(missing))
    }
  })

  it('标题由页面给出、原样存下（conflictCopyTitle 截断到上限的也一样）；标题不合法、查询参数不合法：400，什么也不写', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const long = conflictCopyTitle('长'.repeat(200), CONFLICT_COPY_LABEL)
    expect((await copyOf(await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { title: long }))).title).toBe(long)
    const before = await documentCount()
    const invalid: readonly Readonly<Record<string, string>>[] = [{ title: '' }, { title: '长'.repeat(201) }, { title: '周\n报' }, { requestId: 'not-a-uuid' }, { spaceId: space }]
    for (const query of invalid) {
      const response = await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { query })
      expect(await errorOf(response), JSON.stringify(query)).toMatchObject({ status: 400, code: 'REQUEST_INVALID' })
    }
    const missingTitle = await asUser(app.baseUrl, sessionOf(ben), `/api/documents/${source.id}/conflict-copies?requestId=${randomUUID()}`, {
      method: 'POST',
      binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(pageSnapshot(source.unitId)) },
    })
    expect(await errorOf(missingTitle)).toMatchObject({ status: 400, code: 'REQUEST_INVALID' })
    expect(await documentCount()).toBe(before)
  })
})

describe('US-M3-12 只要求能读原文档；读不到与不存在一致', () => {
  it('US-M3-12 读不到（外人；回收站里的；取消了授权的）：404，与不存在的文档相同，什么也不写', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const trashed = await sourceIn(space)
    expect((await asUser(app.baseUrl, sessionOf(amy), `/api/documents/${trashed.id}`, { method: 'DELETE' })).status).toBe(204)
    await database.query(async client => client.query('DELETE FROM document_grants WHERE document_id = $1 AND user_id = $2', [source.id, gil.id]))
    const before = await documentCount()
    const missing = await errorOf(await postConflictCopy(app.baseUrl, sessionOf(outsider), randomUUID(), randomUUID()))
    expect(missing).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    for (const [account, document] of [[outsider, source], [vic, trashed], [gil, source]] as const)
      expect(await errorOf(await postConflictCopy(app.baseUrl, sessionOf(account), document.id, document.unitId)), account.username).toEqual(missing)
    expect(await documentCount()).toBe(before)
    expect(await copiesOf(source.id)).toEqual([])
  })

  it('快照的顶层 id 不是原文档的 unitId：422 SNAPSHOT_INVALID（unitId 不改写，副本与原文档相同）；什么也不写', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const before = await documentCount()
    const response = await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { raw: pageSnapshot(randomUUID()) })
    expect(await errorOf(response)).toEqual({ status: 422, code: 'SNAPSHOT_INVALID', message: '表格内容不属于这份文档' })
    expect(await documentCount()).toBe(before)
  })

  it.each([
    ['不是 JSON', () => Buffer.from('{"id":', 'utf8')],
    ['顶层是数组', () => Buffer.from('[]', 'utf8')],
    ['sheets 不是对象', (unitId: string) => Buffer.from(JSON.stringify({ id: unitId, sheetOrder: [], sheets: [] }), 'utf8')],
  ])('快照不合格（%s，与保存同一个基本校验）：422 SNAPSHOT_INVALID', async (_case, build) => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const response = await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { raw: build(source.unitId) })
    expect(await errorOf(response)).toMatchObject({ status: 422, code: 'SNAPSHOT_INVALID' })
    expect(await copiesOf(source.id)).toEqual([])
  })

  it('正文的读取与保存相同：内容类型不对 415、带了 Content-Encoding 415；不是 gzip、几个成员拼起来 400；解压后或压缩后超过 5 MiB 413；什么也不写', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const raw = pageSnapshot(source.unitId)
    const before = await documentCount()
    const cases: readonly (readonly [Parameters<typeof postConflictCopy>[4], number, string])[] = [
      [{ contentType: 'application/json', bytes: raw }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [{ headers: { 'content-encoding': 'gzip' } }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [{ bytes: raw }, 400, 'REQUEST_INVALID'],
      [{ bytes: Buffer.concat([zlib.gzipSync(Buffer.alloc(0)), zlib.gzipSync(raw)]) }, 400, 'REQUEST_INVALID'],
      [{ bytes: new Uint8Array() }, 400, 'REQUEST_INVALID'],
      [{ raw: pageSnapshot(source.unitId, 'x'.repeat(SNAPSHOT_MAX_RAW_BYTES)) }, 413, 'PAYLOAD_TOO_LARGE'],
      [{ bytes: randomBytes(SNAPSHOT_MAX_RAW_BYTES + 1) }, 413, 'PAYLOAD_TOO_LARGE'],
    ]
    for (const [request, status, code] of cases) {
      const response = await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, request)
      expect(await errorOf(response), `${status} ${code}`).toMatchObject({ status, code })
    }
    expect(await documentCount()).toBe(before)
  })

  it('没有登录：401；Origin 不是本站：403 ORIGIN_NOT_ALLOWED；缺少 CSRF 令牌：403 CSRF_TOKEN_INVALID；都不写', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const before = await documentCount()
    const anonymous = await fetch(`${app.baseUrl}${conflictCopyPath(source.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/gzip', 'origin': TEST_PUBLIC_ORIGIN },
      body: new Blob([zlib.gzipSync(pageSnapshot(source.unitId))]),
    })
    expect(await errorOf(anonymous)).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' })
    const foreign = await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { headers: { origin: 'https://evil.example' } })
    expect(await errorOf(foreign)).toMatchObject({ status: 403, code: 'ORIGIN_NOT_ALLOWED' })
    const noToken = await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { headers: { [CSRF_TOKEN_HEADER]: undefined } })
    expect(await errorOf(noToken)).toMatchObject({ status: 403, code: 'CSRF_TOKEN_INVALID' })
    expect(await documentCount()).toBe(before)
  })
})

describe('US-M3-13 requestId 幂等（与新建、复制同一个做法）', () => {
  it('US-M3-13 同一个请求重发（回包丢了）：201、同一份副本、replayed 为真，不再建、不再记审计；重新压缩的正文（解压后相同）也是同一个请求', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const requestId = randomUUID()
    const raw = pageSnapshot(source.unitId)
    const first = await copyOf(await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId, raw }))
    expect(first.replayed).toBe(false)
    const again = await copyOf(await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId, bytes: zlib.gzipSync(raw, { level: 1 }) }))
    expect(again).toEqual({ ...first, replayed: true })
    expect(await copiesOf(source.id)).toHaveLength(1)
  })

  it('US-M3-13 结果未知之后被降为查看者（这次本该放进个人空间）：放在哪里不算进摘要，重发照样是重放，返回原来那一份', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const requestId = randomUUID()
    const first = await copyOf(await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId }))
    expect(first.spaceId).toBe(space)
    await setMember(database, space, ben.id, 'viewer')
    const again = await copyOf(await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId }))
    expect([again.id, again.spaceId, again.replayed, again.permissions.canEdit]).toEqual([first.id, space, true, false])
    expect(await copiesOf(source.id)).toHaveLength(1)
  })

  it('同一个 requestId 换了标题、内容或原文档，别人用它：409 REQUEST_ID_CONFLICT，什么也不写', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const other = await sourceIn(space)
    const requestId = randomUUID()
    await copyOf(await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId }))
    const before = await documentCount()
    const conflicts = [
      await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId, title: '另一个标题' }),
      await postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId, raw: pageSnapshot(source.unitId, '又改了一次') }),
      await postConflictCopy(app.baseUrl, sessionOf(ben), other.id, other.unitId, { requestId }),
      await postConflictCopy(app.baseUrl, sessionOf(amy), source.id, source.unitId, { requestId }),
    ]
    for (const response of conflicts)
      expect(await errorOf(response)).toMatchObject({ status: 409, code: 'REQUEST_ID_CONFLICT' })
    expect(await documentCount()).toBe(before)
  })

  it('并发的相同请求：只建一份，每个请求都拿到它（按 requestId 的 advisory lock 排队）', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const requestId = randomUUID()
    const responses = await Promise.all(Array.from({ length: 5 }, async () => postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId })))
    const copies = await Promise.all(responses.map(async response => copyOf(response)))
    expect(new Set(copies.map(copy => copy.id)).size).toBe(1)
    expect(copies.filter(copy => !copy.replayed)).toHaveLength(1)
    expect(await copiesOf(source.id)).toHaveLength(1)
  })
})

describe('US-M3-12 锁下重新判断（确定交错）', () => {
  /** 在持锁的事务里取这个空间的空间树 advisory lock（与结构性改动的第一步相同） */
  function holdSpaceTree(spaceId: string) {
    return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
  }

  it('判断能放进原文档所在的空间之后、取锁之前被降为查看者：锁下重新决定，放进个人空间（另存停在那个空间的树锁上，说明走的是"放进原文档所在的空间"）', async () => {
    const space = await teamSpace()
    const folder = await folderIn(space)
    const source = await sourceIn(space, folder)
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(space),
      request: async () => postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId),
      change: async client => client.query('UPDATE space_members SET role = \'viewer\' WHERE space_id = $1 AND user_id = $2', [space, ben.id]),
    })
    const copy = await copyOf(response)
    expect([copy.spaceId, copy.folderId]).toEqual([ben.personalSpaceId, null])
  })

  it('取树锁之前原文档在空间内换了文件夹：放进它现在（锁下读到）所在的文件夹', async () => {
    const space = await teamSpace()
    const before = await folderIn(space, '原来的')
    const after = await folderIn(space, '现在的')
    const source = await sourceIn(space, before)
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(space),
      request: async () => postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId),
      change: async client => client.query('UPDATE documents SET folder_id = $2 WHERE id = $1', [source.id, after]),
    })
    expect((await copyOf(response)).folderId).toBe(after)
  })

  it('判断能读之后、取空间行的锁之前被移出空间（查看者，放进个人空间的那条路）：锁下重新判断，404，什么也不写', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT 1 FROM spaces WHERE id = $1 FOR UPDATE', [space]),
      request: async () => postConflictCopy(app.baseUrl, sessionOf(vic), source.id, source.unitId),
      change: async client => client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [space, vic.id]),
    })
    expect(await errorOf(response)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await copiesOf(source.id)).toEqual([])
  })

  it('判断能读之后、取原文档行的锁之前取消了授权（只凭授权的人）：锁下重新判断，404，什么也不写', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT 1 FROM documents WHERE id = $1 FOR UPDATE', [source.id]),
      request: async () => postConflictCopy(app.baseUrl, sessionOf(gil), source.id, source.unitId),
      change: async client => client.query('DELETE FROM document_grants WHERE document_id = $1 AND user_id = $2', [source.id, gil.id]),
    })
    expect(await errorOf(response)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await copiesOf(source.id)).toEqual([])
  })

  it('另存持着原文档所在空间的行锁时降级（经接口）：降级等副本提交之后才生效，副本照常放进原文档所在的空间，之后他在那里只能查看', async () => {
    const space = await teamSpace()
    const source = await sourceIn(space)
    const unrelated = await seedDocument(database, { spaceId: outsider.personalSpaceId, createdBy: outsider.id, title: '无关' })
    const requestId = randomUUID()
    const [copied, demoted] = await raceAgainstHeldLock(database, {
      // 让另存停在"锁都已经取到"之后：另一个事务先写一条同一个 requestId 的修订记录、不提交，另存最后写修订记录时就在这个唯一键上等着
      hold: async client => client.query(
        `INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, client_instance_id, local_seq, saved_by)
         VALUES ($1, 1000, 'saved', $2, sha256('held'::bytea), gen_random_uuid(), 1, $3)`,
        [unrelated.id, requestId, outsider.id],
      ),
      request: async (steps) => {
        const copying = steps.step(postConflictCopy(app.baseUrl, sessionOf(ben), source.id, source.unitId, { requestId }))
        await steps.waitForWaiting(1)
        // 调整角色要锁空间行（FOR NO KEY UPDATE）：等在另存持有的共享锁上
        const demoting = steps.step(asUser(app.baseUrl, sessionOf(amy), `/api/spaces/${space}/members/${ben.id}`, { method: 'PUT', body: { role: 'viewer' } }))
        return Promise.all([copying, demoting])
      },
      change: async client => client.query('DELETE FROM document_revisions WHERE request_id = $1', [requestId]),
      waiting: 2,
    })
    const copy = await copyOf(copied)
    expect(demoted.status, await demoted.clone().text()).toBe(200)
    expect(copy.spaceId).toBe(space)
    const after = await asUser(app.baseUrl, sessionOf(ben), `/api/documents/${copy.id}`)
    expect(parseExact(documentDetailSchema, await after.json()).permissions.canEdit).toBe(false)
  })
})
