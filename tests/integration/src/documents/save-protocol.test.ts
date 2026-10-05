// 保存协议加固（M3-P3 设计 §3.1、§3.3、§3.4、§3.5、§3.7、§3.8；US-M3-14、US-M3-16 的服务端部分）：经真实的应用与数据库核对
// - 每条快照规则经真实的保存接口被拒并给出规则（details.rule），不回显内容；另存为副本同样适用；
// - 重放先于其余一切检查：规则收紧之后的重放、旧页面（不带构建与数据格式）的重放、内容相同不递增之后经回执的重放；
// - 拦截旧客户端：数据格式的各项、构建与运维开关（NERVE_MIN_CLIENT_BUILD）在保存、另存为副本、申请编辑权与心跳上；
//   回滚之后文档比服务端新（DOCUMENT_TOO_NEW）；详情的 sdkVersion；
// - 不缩水（含存量为空：解析上一版）；内容相同不递增（只改视图状态也算）与回执；"公式待更新"的记下与清掉，详情、编辑状态与申请的响应；
// - 信封：内容的哈希与资源名、修订记录的哈希与客户端构建、文档的 SDK 版本与客户端构建；新建、复制写哈希。
// M3-P4（US-M3-02、03 的服务端一侧）：自动保存同一份内容连着保存（回执）、修订号只随内容变化增加、结果未知时原样重发；
// "公式待更新"的记下、补存清掉（内容相同只清不设、内容不同照常加修订号）。
// 处理的顺序本身（重放、格式、检查、事务里的各步）在单元测试（document-content.service.test.ts）；看不到与不存在的语句序列在
// permissions/hidden-missing-parity.test.ts。
import type { ClientFormat, SaveContentResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import {
  acquiredEditLeaseSchema,
  canonicalContentText,
  contentHashInput,
  createdDocumentSchema,
  documentDetailSchema,
  EDIT_LEASE_HEADER,
  editStatusSchema,
  errorResponseSchema,
  saveContentResponseSchema,
  SHEET_TEMPLATE,
  sheetSnapshotFor,
  UNIVER_SDK_VERSION,
} from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody, CLIENT_BUILD, clientFormatQuery, CURRENT_CLIENT, renewBody } from '../support/client-format.ts'
import { postConflictCopy } from '../support/conflict-copies.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, releaseLease, saveContent } from '../support/edit-leases.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let amy: TestAccount
let amySession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  amy = await createAccount(database, { username: 'protocol-amy' })
  amySession = await login(app.baseUrl, amy.username, amy.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function amyDocument(title = '表格'): Promise<SeededDocument> {
  return seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title })
}

type Workbook = Record<string, unknown>

/** 模板换上 unitId、A1 写入 value；change 在这份快照上再改几处 */
function workbookOf(unitId: string, value = '内容', change: (workbook: Workbook) => void = () => {}): Workbook {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  const workbook: Workbook = JSON.parse(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } })) as Workbook
  change(workbook)
  return workbook
}

function bytesOf(workbook: Workbook | string): Buffer {
  return Buffer.from(typeof workbook === 'string' ? workbook : JSON.stringify(workbook), 'utf8')
}

/** 规范化的内容哈希（contracts 的口径；服务端用 SHA-256） */
function hashOf(raw: Buffer): Buffer {
  return createHash('sha256').update(contentHashInput(canonicalContentText(raw.toString('utf8')))).digest()
}

/** 资源换成给出的（名称与 data），其余照模板 */
function withResources(resources: readonly { name: string, data: string }[]): (workbook: Workbook) => void {
  return (workbook) => {
    const kept = (workbook.resources as { name: string, data: string }[]).filter(resource => !resources.some(given => given.name === resource.name))
    workbook.resources = [...kept, ...resources]
  }
}

/** "sheet-1" 表 A1 的单元格换成给出的 */
function withCell(cell: unknown): (workbook: Workbook) => void {
  return (workbook) => {
    const sheets = workbook.sheets as Record<string, { cellData: Record<string, Record<string, unknown>> }>
    const sheet = sheets['sheet-1']
    if (sheet !== undefined)
      sheet.cellData = { 0: { 0: cell } }
  }
}

interface SaveOverrides {
  readonly baseRevision?: number
  readonly requestId?: string
  readonly lease?: HeldLease
  /** 覆盖或补充的查询参数（"公式待更新"、写法不对的值） */
  readonly query?: Readonly<Record<string, string>>
  /** 页面上报的构建与数据格式：默认是现在的页面，旧页面给 OLD_PAGE */
  readonly clientFormat?: ClientFormat
}

async function save(document: SeededDocument, raw: Buffer, options: SaveOverrides = {}): Promise<Response> {
  return saveContent(app.baseUrl, amySession, document.id, zlib.gzipSync(raw), {
    baseRevision: options.baseRevision ?? 1,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.clientFormat === undefined ? {} : { clientFormat: options.clientFormat }),
  })
}

async function saved(response: Response): Promise<SaveContentResponse> {
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(saveContentResponseSchema, await response.json())
}

/** 错误：状态码、错误码与详情（请求标识每次不同，不比较） */
async function errorOf(response: Response): Promise<{ status: number, code: string, details?: unknown }> {
  const { code, details } = parseExact(errorResponseSchema, await response.json()).error
  return { status: response.status, code, ...(details === undefined ? {} : { details }) }
}

/** P3 之前的页面：不带构建与数据格式（也不带"公式待更新"） */
const OLD_PAGE: ClientFormat = {}

interface Envelope {
  readonly revision: number
  readonly sdkVersion: string
  readonly clientBuild: string | null
  readonly formulasPending: boolean
  readonly contentHash: Buffer | null
  readonly resourceNames: string[] | null
  readonly updatedAt: Date
}

/** 文档、内容与当前修订的信封 */
async function envelopeOf(documentId: string): Promise<Envelope> {
  const row = await database.query(async client => (await client.query<Envelope>(
    `SELECT d.revision, d.sdk_version AS "sdkVersion", d.client_build AS "clientBuild", d.formulas_pending AS "formulasPending",
            c.content_hash AS "contentHash", c.resource_names AS "resourceNames", d.updated_at AS "updatedAt"
     FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1`,
    [documentId],
  )).rows[0])
  if (row === undefined)
    throw new Error(`没有文档 ${documentId}`)
  return row
}

async function revisionsOf(documentId: string): Promise<{ revision: number, content_hash: Buffer | null, client_build: string | null }[]> {
  return database.query(async client => (await client.query<{ revision: number, content_hash: Buffer | null, client_build: string | null }>(
    'SELECT revision, content_hash, client_build FROM document_revisions WHERE document_id = $1 ORDER BY revision',
    [documentId],
  )).rows)
}

async function receiptsOf(documentId: string): Promise<{ request_id: string, revision: number, saved_at: Date }[]> {
  return database.query(async client => (await client.query<{ request_id: string, revision: number, saved_at: Date }>(
    'SELECT request_id, revision, saved_at FROM document_save_receipts WHERE document_id = $1 ORDER BY created_at',
    [documentId],
  )).rows)
}

async function auditsOf(documentId: string): Promise<number> {
  return database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_events WHERE action = \'documents.content_saved\' AND target_id = $1', [documentId])).rows[0]?.count ?? 0)
}

const LINK = (url: string, rangeId = 'link1') => ({ p: { id: 'd', body: { dataStream: 'abc\r\n', customRanges: [{ startIndex: 0, endIndex: 2, rangeId, rangeType: 0, properties: { url } }] } } })

describe('US-M3-14 每条快照规则经真实的保存接口被拒，给出规则（details.rule），不写入', () => {
  const CASES: readonly (readonly [string, string, (unitId: string) => Buffer])[] = [
    ['不是 UTF-8', 'encoding', () => Buffer.from([0x7B, 0xFF, 0x7D])],
    ['嵌套超过 64 层（外层）', 'depth', unitId => bytesOf(`{"id":"${unitId}","sheetOrder":[],"sheets":{},"x":${'['.repeat(70)}${']'.repeat(70)}}`)],
    ['嵌套超过 64 层（资源 data 里的 JSON 与外层累加）', 'depth', unitId => bytesOf(workbookOf(unitId, 'x', withResources([{ name: 'SHEET_NOTE_PLUGIN', data: `{"s":${'['.repeat(62)}${']'.repeat(62)}}` }])))],
    ['元素超过 150 万个', 'entries', unitId => bytesOf(`{"id":"${unitId}","sheetOrder":[],"sheets":{},"x":[${Array.from({ length: 1_600_000 }).fill(0).join(',')}]}`)],
    ['不是 JSON', 'json', unitId => bytesOf(`{"id":"${unitId}",`)],
    ['顶层是数组', 'structure', unitId => bytesOf(JSON.stringify([unitId]))],
    ['sheetOrder 里有 sheets 里没有的表', 'structure', unitId => bytesOf(workbookOf(unitId, 'x', (workbook) => {
      workbook.sheetOrder = ['sheet-1', 'missing']
    }))],
    ['resources 不是数组', 'resources', unitId => bytesOf(workbookOf(unitId, 'x', (workbook) => {
      workbook.resources = { a: 1 }
    }))],
    ['资源名重复', 'resource-duplicate', unitId => bytesOf(workbookOf(unitId, 'x', (workbook) => {
      workbook.resources = [...(workbook.resources as unknown[]), { name: 'SHEET_NOTE_PLUGIN', data: '' }]
    }))],
    ['资源名不在档案的白名单里', 'resource-unknown', unitId => bytesOf(workbookOf(unitId, 'x', withResources([{ name: 'SHEET_AuthzIoMockService_PLUGIN', data: '{}' }])))],
    ['已知资源的结构不对', 'resource-data', unitId => bytesOf(workbookOf(unitId, 'x', withResources([{ name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: '{"unexpected":"shape","value":42}' }])))],
    ['必须为空的资源不为空（区域保护）', 'resource-not-empty', unitId => bytesOf(workbookOf(unitId, 'x', withResources([{ name: 'SHEET_RANGE_PROTECTION_PLUGIN', data: '{"sheet-1":[{"permissionId":"p","unitType":3}]}' }])))],
    ['图片地址不是平台地址（单元格图片）', 'image-source', unitId => bytesOf(workbookOf(unitId, 'x', withCell({ p: { id: 'd', body: { dataStream: '\b\r\n' }, drawings: { img: { source: 'data:image/png;base64,iVBORw0KGgo=' } } } })))],
    ['图片地址不是平台地址（浮动图片的资源）', 'image-source', unitId => bytesOf(workbookOf(unitId, 'x', withResources([{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ 'sheet-1': { data: { d1: { source: 'https://example.com/a.png' } }, order: ['d1'] } }) }])))],
    ['链接区间看不懂', 'link-structure', unitId => bytesOf(workbookOf(unitId, 'x', withCell({ p: { id: 'd', body: { dataStream: 'abc\r\n', customRanges: 'x' } } })))],
    ['链接地址不合法', 'link-address', unitId => bytesOf(workbookOf(unitId, 'x', withCell(LINK('javascript:alert(1)'))))],
    ['链接地址不是规范写法', 'link-address', unitId => bytesOf(workbookOf(unitId, 'x', withCell(LINK('https://example.com'))))],
    ['链接的 rangeId 不合写法', 'link-range-id', unitId => bytesOf(workbookOf(unitId, 'x', withCell(LINK('https://example.com/', 'bad id"'))))],
    ['unitId 是别的文档的', 'unit-id', () => bytesOf(workbookOf(randomUUID()))],
  ]

  it.each(CASES)('%s：422 SNAPSHOT_INVALID，规则 %s；修订号、内容不变，说明里没有快照的内容', async (_case, rule, build) => {
    const document = await amyDocument()
    const before = await envelopeOf(document.id)
    const response = await save(document, build(document.unitId))
    const text = await response.clone().text()
    expect(await errorOf(response)).toEqual({ status: 422, code: 'SNAPSHOT_INVALID', details: { rule } })
    expect(text).not.toContain('example.com')
    expect(text).not.toContain('javascript')
    expect(await envelopeOf(document.id)).toEqual(before)
    // 日志记规则与文档 id
    expect(app.logs.entries().some(entry => entry.msg === '快照不合格，拒绝写入' && entry.rule === rule && entry.documentId === document.id)).toBe(true)
  })

  it('阴性对照：规范写法的链接、本站相对地址的链接、文档内锚点、变空的必须为空的资源（{ 表: [] }）、平台的图片地址都照常保存', async () => {
    const document = await amyDocument()
    const ok = workbookOf(document.unitId, 'x', (workbook) => {
      withCell(LINK('https://example.com/'))(workbook)
      const sheets = workbook.sheets as Record<string, { cellData: Record<string, Record<string, unknown>> }>
      const cells = sheets['sheet-1']?.cellData ?? {}
      cells[1] = { 0: LINK('/documents/abc?x=1#h') }
      cells[2] = { 0: LINK('#gid=sheet-1&range=A1') }
      cells[3] = { 0: LINK('mailto:user@example.com') }
      cells[4] = { 0: { p: { id: 'd', body: { dataStream: '\b\r\n' }, drawings: { img: { source: `/api/assets/${randomUUID()}` } } } } }
      withResources([{ name: 'SHEET_RANGE_PROTECTION_PLUGIN', data: '{"sheet-1":[]}' }])(workbook)
    })
    expect((await saved(await save(document, bytesOf(ok)))).revision).toBe(2)
  })
})

describe('US-M3-14 不缩水（00 号计划书 §8.2）：上一版非空的资源，这一版都要在', () => {
  const NOTE = { name: 'SHEET_NOTE_PLUGIN', data: '{"sheet-1":{"0":{"0":{"note":"备注","width":160,"height":60,"id":"n1","row":0,"col":0}}}}' }

  it('有备注的一版之后，没有备注资源的快照：422 resource-missing，记 warn；删光备注（变空）照常保存', async () => {
    const document = await amyDocument()
    await saved(await save(document, bytesOf(workbookOf(document.unitId, 'x', withResources([NOTE])))))
    expect((await envelopeOf(document.id)).resourceNames).toEqual(['SHEET_NOTE_PLUGIN'])
    const dropped = workbookOf(document.unitId, 'y', (workbook) => {
      workbook.resources = (workbook.resources as { name: string }[]).filter(resource => resource.name !== 'SHEET_NOTE_PLUGIN')
    })
    expect(await errorOf(await save(document, bytesOf(dropped), { baseRevision: 2 }))).toEqual({ status: 422, code: 'SNAPSHOT_INVALID', details: { rule: 'resource-missing' } })
    expect(app.logs.entries().find(entry => entry.rule === 'resource-missing' && entry.documentId === document.id)).toMatchObject({ missing: ['SHEET_NOTE_PLUGIN'] })
    expect((await saved(await save(document, bytesOf(workbookOf(document.unitId, 'y', withResources([{ name: 'SHEET_NOTE_PLUGIN', data: '{"sheet-1":{}}' }]))), { baseRevision: 2 }))).revision).toBe(3)
    expect((await envelopeOf(document.id)).resourceNames).toEqual([])
  })

  it('存量（P3 之前写的，资源名为空）：解析上一版得到非空的资源，照样拦下缩水；白名单之外的（M1 去掉的 AuthzIoMock）不算', async () => {
    const document = await amyDocument()
    const legacy = JSON.stringify(workbookOf(document.unitId, '旧的', (workbook) => {
      withResources([NOTE])(workbook)
      workbook.resources = [...(workbook.resources as unknown[]), { name: 'SHEET_AuthzIoMockService_PLUGIN', data: '{"x":1}' }]
    }))
    const gzipped = zlib.gzipSync(legacy)
    await database.query(async client => client.query('UPDATE document_contents SET snapshot = $2, raw_bytes = $3, stored_bytes = $4 WHERE document_id = $1', [document.id, gzipped, Buffer.byteLength(legacy), gzipped.length]))
    expect((await envelopeOf(document.id)).resourceNames).toBeNull()
    const withoutNote = workbookOf(document.unitId, '新的', (workbook) => {
      workbook.resources = (workbook.resources as { name: string }[]).filter(resource => resource.name !== 'SHEET_NOTE_PLUGIN')
    })
    expect(await errorOf(await save(document, bytesOf(withoutNote)))).toMatchObject({ details: { rule: 'resource-missing' } })
    // 备注在（AuthzIoMock 不在了：白名单之外的不算缩水）：照常保存
    expect((await saved(await save(document, bytesOf(workbookOf(document.unitId, '新的', withResources([NOTE])))))).revision).toBe(2)
  })
})

describe('US-M3-14 内容相同不递增与回执（M3-P3 设计 §3.7）', () => {
  it('内容相同：修订号不变，给出当前修订与它的时间（unchanged）；不写内容、修订记录与审计，更新时间不变；写一条回执', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId))
    const first = await saved(await save(document, raw))
    const before = await envelopeOf(document.id)
    const requestId = randomUUID()
    expect(await saved(await save(document, raw, { baseRevision: 2, requestId }))).toEqual({ revision: 2, savedAt: first.savedAt, unchanged: true })
    expect(await envelopeOf(document.id)).toEqual(before)
    expect(await revisionsOf(document.id)).toHaveLength(2)
    expect(await auditsOf(document.id)).toBe(1)
    expect(await receiptsOf(document.id)).toEqual([{ request_id: requestId, revision: 2, saved_at: new Date(first.savedAt) }])
  })

  it('只改了视图状态（缩放、滚动）也算相同（计划书 §7.3）；资源"在而为空"与"不在"也算相同', async () => {
    const document = await amyDocument()
    await saved(await save(document, bytesOf(workbookOf(document.unitId))))
    const scrolled = workbookOf(document.unitId, '内容', (workbook) => {
      const sheet = (workbook.sheets as Record<string, Record<string, unknown>>)['sheet-1']
      if (sheet !== undefined)
        Object.assign(sheet, { zoomRatio: 1.5, scrollTop: 300, scrollLeft: 20 })
      workbook.resources = (workbook.resources as { name: string }[]).filter(resource => resource.name !== 'SHEET_FILTER_PLUGIN')
    })
    expect(await saved(await save(document, bytesOf(scrolled), { baseRevision: 2 }))).toMatchObject({ revision: 2, unchanged: true })
  })

  it('回执的重放（A07）：内容相同的那次确认结果未知，之后编辑权被释放、被别人接手，原样重发照样拿到原来的确认，不再写回执', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId))
    await saved(await save(document, raw))
    const lease = await acquireLease(app.baseUrl, amySession, document.id)
    const requestId = randomUUID()
    const first = await saved(await save(document, raw, { baseRevision: 2, requestId, lease }))
    expect(first.unchanged).toBe(true)
    await releaseLease(app.baseUrl, amySession, document.id, lease)
    // 别的标签页接手：原来的租约失效
    const other = await acquireLease(app.baseUrl, amySession, document.id)
    expect(await saved(await save(document, raw, { baseRevision: 2, requestId, lease }))).toEqual(first)
    expect(await receiptsOf(document.id)).toHaveLength(1)
    await releaseLease(app.baseUrl, amySession, document.id, other)
    // 同一个 requestId、内容不同：不是那一次
    expect(await errorOf(await save(document, bytesOf(workbookOf(document.unitId, '改了')), { baseRevision: 2, requestId }))).toMatchObject({ status: 409, code: 'REQUEST_ID_CONFLICT' })
  })
})

describe('重放先于其余一切检查（00 号计划书 §7.4 第 2 步，M3 总设计 §6.3）', () => {
  /** 直接摆下一次已经提交的保存（修订号 2）：摘要按服务端的写法（没有"公式待更新"时与 P3 之前的写法逐字节相同） */
  async function committed(document: SeededDocument, raw: Buffer, requestId: string): Promise<void> {
    const digest = createHash('sha256').update('saved\n1\n', 'utf8').update(raw).digest()
    await database.query(async (client) => {
      await client.query(
        `INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, client_instance_id, local_seq, saved_by)
         VALUES ($1, 2, 'saved', $2, $3, $4, 1, $5)`,
        [document.id, requestId, digest, randomUUID(), amy.id],
      )
      await client.query('UPDATE documents SET revision = 2 WHERE id = $1', [document.id])
    })
  }

  it('规则收紧之后的重放：升级之前提交了的那次保存，内容按现在的规则不合格（data: 图片），原样重发照样 200、拿到原来的结果', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId, 'x', withCell({ p: { id: 'd', body: { dataStream: '\b\r\n' }, drawings: { img: { source: 'data:image/png;base64,iVBORw0KGgo=' } } } })))
    const requestId = randomUUID()
    await committed(document, raw, requestId)
    expect(await saved(await save(document, raw, { requestId, clientFormat: OLD_PAGE }))).toMatchObject({ revision: 2, unchanged: false })
    // 不是重放（新的 requestId）：按现在的规则被拒——先被拦成过旧（旧页面），现在的页面则是快照不合格
    expect(await errorOf(await save(document, raw, { baseRevision: 2, clientFormat: OLD_PAGE }))).toMatchObject({ status: 409, code: 'CLIENT_OUTDATED' })
    expect(await errorOf(await save(document, raw, { baseRevision: 2 }))).toMatchObject({ status: 422, details: { rule: 'image-source' } })
  })

  it('旧页面的重放：P3 之前的页面（不带构建与数据格式）提交了、回包丢了，升级之后原样重发拿到原来的结果，而不是"需要刷新"', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId, '旧页面'))
    const requestId = randomUUID()
    await committed(document, raw, requestId)
    expect(await saved(await save(document, raw, { requestId, clientFormat: OLD_PAGE }))).toMatchObject({ revision: 2, unchanged: false })
    expect((await envelopeOf(document.id)).revision).toBe(2)
  })

  it('回执的重放先于格式拦截：内容相同的那次确认结果未知，运维随后调高了最低构建（NERVE_MIN_CLIENT_BUILD），原样重发拿到原来的确认（unchanged），而不是"需要刷新"', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId))
    await saved(await save(document, raw))
    const requestId = randomUUID()
    const first = await saved(await save(document, raw, { baseRevision: 2, requestId }))
    expect(first.unchanged).toBe(true)
    const strict = await startTestApp({ databaseUrl: database.url, env: { NERVE_MIN_CLIENT_BUILD: '99.0.0' } })
    try {
      const session = await login(strict.baseUrl, amy.username, amy.password)
      // 申请在这个应用上被拦下，saveContent 随之用谁的也不是的租约发出：重放先于格式与租约
      expect(await saved(await saveContent(strict.baseUrl, session, document.id, zlib.gzipSync(raw), { baseRevision: 2, requestId }))).toEqual(first)
      // 不是重放（新的 requestId）：照样被拦成过旧
      expect(await errorOf(await saveContent(strict.baseUrl, session, document.id, zlib.gzipSync(raw), { baseRevision: 2 }))).toEqual({ status: 409, code: 'CLIENT_OUTDATED', details: { reason: 'build' } })
    }
    finally {
      await strict.close()
    }
    expect(await receiptsOf(document.id)).toHaveLength(1)
  })

  it('规则收紧之后的回执重放：升级之前那次内容相同的确认（回执），内容按现在的规则不合格（data: 图片），旧页面原样重发照样拿到原来的确认', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId, 'x', withCell({ p: { id: 'd', body: { dataStream: '\b\r\n' }, drawings: { img: { source: 'data:image/png;base64,iVBORw0KGgo=' } } } })))
    const requestId = randomUUID()
    // 直接摆下那次确认的回执（修订号 1、摘要按服务端的写法），保存时间是当时当前修订的时间
    const savedAt = new Date('2026-09-26T08:00:00.000Z')
    const digest = createHash('sha256').update('saved\n1\n', 'utf8').update(raw).digest()
    await database.query(async client => client.query(
      'INSERT INTO document_save_receipts (request_id, document_id, revision, payload_digest, saved_by, saved_at) VALUES ($1, $2, 1, $3, $4, $5)',
      [requestId, document.id, digest, amy.id, savedAt],
    ))
    expect(await saved(await save(document, raw, { requestId, clientFormat: OLD_PAGE }))).toEqual({ revision: 1, savedAt: savedAt.toISOString(), unchanged: true })
    expect(await saved(await save(document, raw, { requestId }))).toEqual({ revision: 1, savedAt: savedAt.toISOString(), unchanged: true })
    // 不是重放（新的 requestId）：按现在的规则被拒
    expect(await errorOf(await save(document, raw, { clientFormat: OLD_PAGE }))).toMatchObject({ status: 409, code: 'CLIENT_OUTDATED' })
    expect(await errorOf(await save(document, raw))).toMatchObject({ status: 422, details: { rule: 'image-source' } })
    expect(await receiptsOf(document.id)).toHaveLength(1)
  })
})

describe('US-M3-16 拦截旧客户端：保存、另存为副本、申请编辑权与心跳（M3-P3 设计 §3.5）', () => {
  /** 过旧的几种上报：数据格式的每一项不同、没上报（P3 之前的页面）、构建没上报 */
  const OUTDATED: readonly (readonly [string, ClientFormat, string])[] = [
    ['Univer 版本不同', { ...CURRENT_CLIENT, univerVersion: '0.9.0' }, 'format'],
    ['插件档案不同', { ...CURRENT_CLIENT, profile: 'sheet@0' }, 'format'],
    ['平台格式版本不同', { ...CURRENT_CLIENT, formatVersion: 2 }, 'format'],
    ['P3 之前的页面（都没上报）', OLD_PAGE, 'format'],
    ['没上报构建', { ...CURRENT_CLIENT, clientBuild: undefined }, 'build'],
  ]

  it.each(OUTDATED)('%s：保存 409 CLIENT_OUTDATED（%s）；不写入', async (_case, clientFormat, reason) => {
    const document = await amyDocument()
    expect(await errorOf(await save(document, bytesOf(workbookOf(document.unitId)), { clientFormat }))).toEqual({ status: 409, code: 'CLIENT_OUTDATED', details: { reason } })
    expect((await envelopeOf(document.id)).revision).toBe(1)
  })

  it.each(OUTDATED)('%s：另存为副本 409 CLIENT_OUTDATED，不建副本', async (_case, clientFormat, reason) => {
    const document = await amyDocument()
    const response = await postConflictCopy(app.baseUrl, amySession, document.id, document.unitId, { clientFormat })
    expect(await errorOf(response)).toEqual({ status: 409, code: 'CLIENT_OUTDATED', details: { reason } })
    // 确实没建副本：副本与原文档的 unitId 相同，库里只有原文档这一份；也没有另存为副本的审计
    expect(await database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM documents WHERE unit_id = $1', [document.unitId])).rows[0]?.count)).toBe(1)
    expect(await database.query(async client => (await client.query('SELECT 1 FROM audit_events WHERE action = \'documents.conflict_copied\' AND details->>\'sourceId\' = $1', [document.id])).rowCount)).toBe(0)
  })

  it.each(OUTDATED)('%s：申请 409 CLIENT_OUTDATED，不写租约', async (_case, clientFormat, reason) => {
    const document = await amyDocument()
    const response = await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/edit-lease`, { method: 'POST', body: acquireBody(randomUUID(), clientFormat) })
    expect(await errorOf(response)).toEqual({ status: 409, code: 'CLIENT_OUTDATED', details: { reason } })
    expect(await database.query(async client => (await client.query('SELECT 1 FROM document_edit_leases WHERE document_id = $1', [document.id])).rowCount)).toBe(0)
  })

  it.each(OUTDATED)('%s：心跳 409 CLIENT_OUTDATED，不续租（服务端升级之后，正在编辑的页面一次心跳之内就停下）', async (_case, body, reason) => {
    const document = await amyDocument()
    const lease = await acquireLease(app.baseUrl, amySession, document.id)
    const before = await database.query(async client => (await client.query<{ renewed_at: Date }>('SELECT renewed_at FROM document_edit_leases WHERE document_id = $1', [document.id])).rows[0]?.renewed_at)
    const response = await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/edit-lease`, { method: 'PUT', body: renewBody(0, body), headers: { [EDIT_LEASE_HEADER]: lease.token } })
    expect(await errorOf(response)).toEqual({ status: 409, code: 'CLIENT_OUTDATED', details: { reason } })
    expect(await database.query(async client => (await client.query<{ renewed_at: Date }>('SELECT renewed_at FROM document_edit_leases WHERE document_id = $1', [document.id])).rows[0]?.renewed_at)).toEqual(before)
    await releaseLease(app.baseUrl, amySession, document.id, lease)
  })

  it('构建的写法不对（不是 x.y.z）：400 REQUEST_INVALID（契约），与过旧分开', async () => {
    const document = await amyDocument()
    expect((await save(document, bytesOf(workbookOf(document.unitId)), { query: { clientBuild: 'latest' } })).status).toBe(400)
    const acquire = await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/edit-lease`, { method: 'POST', body: acquireBody(randomUUID(), { ...CURRENT_CLIENT, clientBuild: '1.0' }) })
    expect(acquire.status).toBe(400)
  })

  it('运维开关（NERVE_MIN_CLIENT_BUILD）：构建低于它的页面在保存、副本、申请、心跳上都 409（build）；等于、高于它的照常，+ 之后的诊断信息不比较；不设时不按构建拦', async () => {
    const strict = await startTestApp({ databaseUrl: database.url, env: { NERVE_MIN_CLIENT_BUILD: '99.0.0' } })
    try {
      const session = await login(strict.baseUrl, amy.username, amy.password)
      const document = await amyDocument()
      const raw = zlib.gzipSync(bytesOf(workbookOf(document.unitId)))
      // 现在的页面（构建低于开关）：申请就被拦下，saveContent 随之用谁的也不是的租约发出保存，保存同样被拦（格式在判断访问与租约之前）
      expect(await errorOf(await saveContent(strict.baseUrl, session, document.id, raw, { baseRevision: 1 }))).toEqual({ status: 409, code: 'CLIENT_OUTDATED', details: { reason: 'build' } })
      expect(await errorOf(await postConflictCopy(strict.baseUrl, session, document.id, document.unitId))).toMatchObject({ code: 'CLIENT_OUTDATED', details: { reason: 'build' } })
      const lease = await acquireLease(app.baseUrl, amySession, document.id)
      const renew = await asUser(strict.baseUrl, session, `/api/documents/${document.id}/edit-lease`, { method: 'PUT', body: renewBody(0), headers: { [EDIT_LEASE_HEADER]: lease.token } })
      expect(await errorOf(renew)).toMatchObject({ code: 'CLIENT_OUTDATED', details: { reason: 'build' } })
      await releaseLease(app.baseUrl, amySession, document.id, lease)
      // 等于、高于开关的构建：申请、保存都照常（+ 之后的诊断信息不比较）
      for (const clientBuild of ['99.0.0', '99.0.0+0123abcd', '100.2.3']) {
        const fresh = await amyDocument()
        const format = { ...CURRENT_CLIENT, clientBuild }
        const tab = randomUUID()
        const acquired = parseExact(acquiredEditLeaseSchema, await (await asUser(strict.baseUrl, session, `/api/documents/${fresh.id}/edit-lease`, { method: 'POST', body: acquireBody(tab, format) })).json())
        const ok = await saveContent(strict.baseUrl, session, fresh.id, zlib.gzipSync(bytesOf(workbookOf(fresh.unitId))), { baseRevision: 1, lease: { token: acquired.token, writeEpoch: acquired.writeEpoch, clientInstanceId: tab }, clientFormat: format })
        expect(ok.status, `${clientBuild}：${await ok.clone().text()}`).toBe(200)
        await ok.arrayBuffer()
        expect((await envelopeOf(fresh.id)).clientBuild).toBe(clientBuild)
      }
    }
    finally {
      await strict.close()
    }
    // 不设开关的应用：同样低的构建照常保存
    const document = await amyDocument()
    expect((await saved(await save(document, bytesOf(workbookOf(document.unitId)), { clientFormat: { ...CURRENT_CLIENT, clientBuild: '0.0.1' } }))).revision).toBe(2)
  })

  it('回滚之后文档比服务端新（文档记录的 SDK 版本更高）：详情给出 sdkVersion；保存与申请 409 DOCUMENT_TOO_NEW；看不到的照样 404', async () => {
    const document = await amyDocument()
    await database.query(async client => client.query('UPDATE documents SET sdk_version = \'99.0.0\' WHERE id = $1', [document.id]))
    const detail = parseExact(documentDetailSchema, await (await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`)).json())
    expect(detail.sdkVersion).toBe('99.0.0')
    const acquire = await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/edit-lease`, { method: 'POST', body: acquireBody(randomUUID()) })
    expect(await errorOf(acquire)).toEqual({ status: 409, code: 'DOCUMENT_TOO_NEW' })
    // 保存（谁的也不是的租约：申请不了）：DOCUMENT_TOO_NEW 在租约之前
    expect(await errorOf(await save(document, bytesOf(workbookOf(document.unitId))))).toEqual({ status: 409, code: 'DOCUMENT_TOO_NEW' })
    expect((await envelopeOf(document.id)).revision).toBe(1)
    const outsider = await createAccount(database, { username: 'protocol-outsider' })
    const outsiderSession = await login(app.baseUrl, outsider.username, outsider.password)
    const hidden = await asUser(app.baseUrl, outsiderSession, `/api/documents/${document.id}/edit-lease`, { method: 'POST', body: acquireBody(randomUUID()) })
    expect(hidden.status).toBe(404)
    await hidden.arrayBuffer()
  })
})

describe('信封（00 号计划书 §8.1）', () => {
  it('保存写下内容的哈希与资源名、修订记录的哈希与客户端构建、文档的 SDK 版本（上报、核对过的）与客户端构建', async () => {
    const document = await amyDocument()
    await database.query(async client => client.query('UPDATE documents SET sdk_version = \'0.9.9\' WHERE id = $1', [document.id]))
    const raw = bytesOf(workbookOf(document.unitId, 'x', withResources([{ name: 'SHEET_NOTE_PLUGIN', data: '{"sheet-1":{"0":{"0":{"note":"n"}}}}' }])))
    await saved(await save(document, raw, { query: { clientBuild: `${CLIENT_BUILD}+abc123` } }))
    expect(await envelopeOf(document.id)).toMatchObject({ revision: 2, sdkVersion: UNIVER_SDK_VERSION, clientBuild: `${CLIENT_BUILD}+abc123`, formulasPending: false, contentHash: hashOf(raw), resourceNames: ['SHEET_NOTE_PLUGIN'] })
    expect((await revisionsOf(document.id)).at(-1)).toEqual({ revision: 2, content_hash: hashOf(raw), client_build: `${CLIENT_BUILD}+abc123` })
  })

  it('新建写模板的哈希与资源名（每份文档单独算）；复制连同哈希与资源名带过去，"公式待更新"与客户端构建照源文档', async () => {
    const created = parseExact(createdDocumentSchema, await (await asUser(app.baseUrl, amySession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId: randomUUID() } })).json())
    const createdEnvelope = await envelopeOf(created.id)
    const template = Buffer.from(sheetSnapshotFor(String((await database.query(async client => (await client.query<{ unit_id: string }>('SELECT unit_id FROM documents WHERE id = $1', [created.id])).rows[0]?.unit_id)))), 'utf8')
    expect(createdEnvelope).toMatchObject({ contentHash: hashOf(template), resourceNames: [], clientBuild: null, formulasPending: false })
    expect((await revisionsOf(created.id))[0]).toEqual({ revision: 1, content_hash: hashOf(template), client_build: null })
    // 新建之后立即保存同样的内容：不加修订号（模板收敛）
    const unchanged = await saveContent(app.baseUrl, amySession, created.id, zlib.gzipSync(template), { baseRevision: 1 })
    expect(await saved(unchanged)).toMatchObject({ revision: 1, unchanged: true })

    const source = await amyDocument('源')
    const raw = bytesOf(workbookOf(source.unitId, 'x', withResources([{ name: 'SHEET_NOTE_PLUGIN', data: '{"sheet-1":{"0":{"0":{"note":"n"}}}}' }])))
    await saved(await save(source, raw, { query: { formulasPending: 'true' } }))
    const copied = parseExact(createdDocumentSchema, await (await asUser(app.baseUrl, amySession, `/api/documents/${source.id}/copy`, { method: 'POST', body: { spaceId: amy.personalSpaceId, requestId: randomUUID() } })).json())
    expect(await envelopeOf(copied.id)).toMatchObject({ contentHash: hashOf(raw), resourceNames: ['SHEET_NOTE_PLUGIN'], clientBuild: CLIENT_BUILD, formulasPending: true })
    expect((await revisionsOf(copied.id))[0]).toEqual({ revision: 1, content_hash: hashOf(raw), client_build: null })
    expect(copied.formulasPending).toBe(true)
  })

  it('另存为副本：完整的检查（非平台的图片地址 422 image-source）；信封与"公式待更新"、内容的哈希与资源名写在副本上', async () => {
    const source = await amyDocument('原文档')
    const bad = bytesOf(workbookOf(source.unitId, 'x', withCell({ p: { id: 'd', body: { dataStream: '\b\r\n' }, drawings: { img: { source: 'https://example.com/a.png' } } } })))
    expect(await errorOf(await postConflictCopy(app.baseUrl, amySession, source.id, source.unitId, { raw: bad }))).toEqual({ status: 422, code: 'SNAPSHOT_INVALID', details: { rule: 'image-source' } })
    const raw = bytesOf(workbookOf(source.unitId, '本页的修改', withResources([{ name: 'SHEET_NOTE_PLUGIN', data: '{"sheet-1":{"0":{"0":{"note":"n"}}}}' }])))
    // 原文档由更新的版本写过（回滚之后）：副本的信封是本页的（核对过、等于服务端的），不照抄原文档（审查 A7）
    await database.query(async client => client.query('UPDATE documents SET sdk_version = \'99.0.0\' WHERE id = $1', [source.id]))
    const copy = parseExact(createdDocumentSchema, await (await postConflictCopy(app.baseUrl, amySession, source.id, source.unitId, { raw, query: { formulasPending: 'true', clientBuild: `${CLIENT_BUILD}+copy` } })).json())
    expect(copy).toMatchObject({ formulasPending: true, sdkVersion: UNIVER_SDK_VERSION, profile: CURRENT_CLIENT.profile, formatVersion: CURRENT_CLIENT.formatVersion })
    expect(await envelopeOf(copy.id)).toMatchObject({ sdkVersion: UNIVER_SDK_VERSION, clientBuild: `${CLIENT_BUILD}+copy`, formulasPending: true, contentHash: hashOf(raw), resourceNames: ['SHEET_NOTE_PLUGIN'] })
    expect(await database.query(async client => (await client.query<{ profile: string, format_version: number }>('SELECT profile, format_version FROM documents WHERE id = $1', [copy.id])).rows[0]))
      .toEqual({ profile: CURRENT_CLIENT.profile, format_version: CURRENT_CLIENT.formatVersion })
    expect((await revisionsOf(copy.id))[0]).toEqual({ revision: 1, content_hash: hashOf(raw), client_build: `${CLIENT_BUILD}+copy` })
  })

  it('另存为副本的档案与格式版本同样取本页的（审查 A7）：原文档由别的版本写过、档案与格式版本不是服务端的，副本照样标着本页的', async () => {
    const source = await amyDocument('别的版本写的')
    // 现在的库只认这一版的档案与格式版本（CHECK 约束）：暂时去掉这两条约束，摆下别的版本写的原文档，做完改回、再加回约束
    const constraints = ['documents_profile_check', 'documents_format_version_check']
    const definitions = await database.query(async client => (await client.query<{ name: string, definition: string }>(
      'SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = \'documents\'::regclass AND conname = ANY($1) ORDER BY conname',
      [constraints],
    )).rows)
    expect(definitions.map(row => row.name)).toEqual([...constraints].sort())
    await database.query(async (client) => {
      for (const { name } of definitions)
        await client.query(`ALTER TABLE documents DROP CONSTRAINT ${name}`)
      await client.query('UPDATE documents SET profile = \'sheet@2\', format_version = 2, sdk_version = \'99.0.0\' WHERE id = $1', [source.id])
    })
    try {
      const raw = bytesOf(workbookOf(source.unitId, '本页的修改'))
      const copy = parseExact(createdDocumentSchema, await (await postConflictCopy(app.baseUrl, amySession, source.id, source.unitId, { raw })).json())
      expect(await database.query(async client => (await client.query<{ profile: string, format_version: number, sdk_version: string }>('SELECT profile, format_version, sdk_version FROM documents WHERE id = $1', [copy.id])).rows[0]))
        .toEqual({ profile: CURRENT_CLIENT.profile, format_version: CURRENT_CLIENT.formatVersion, sdk_version: UNIVER_SDK_VERSION })
    }
    finally {
      await database.query(async (client) => {
        await client.query('UPDATE documents SET profile = $2, format_version = $3, sdk_version = $4 WHERE id = $1', [source.id, CURRENT_CLIENT.profile, CURRENT_CLIENT.formatVersion, UNIVER_SDK_VERSION])
        for (const { name, definition } of definitions)
          await client.query(`ALTER TABLE documents ADD CONSTRAINT ${name} ${definition}`)
      })
    }
  })
})

describe('US-M3-03 "公式待更新"：超过上限时带标记的保存记下，收齐之后的补存清掉；进入编辑时据此强制重算（M3-P3 设计 §3.4、§3.8；M3-P4 设计 §3.5）', () => {
  it('US-M3-03 "公式待更新"：带标记的保存记下（详情、编辑状态、申请的响应都给出），内容相同的保存不带标记时清掉（修订号不变）', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId))
    await saved(await save(document, raw, { query: { formulasPending: 'true' } }))
    const detail = async () => parseExact(documentDetailSchema, await (await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`)).json()).formulasPending
    const status = async () => parseExact(editStatusSchema, await (await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/edit-lease`)).json()).formulasPending
    expect([await detail(), await status()]).toEqual([true, true])
    const acquired = parseExact(acquiredEditLeaseSchema, await (await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/edit-lease`, { method: 'POST', body: acquireBody(randomUUID()) })).json())
    expect(acquired.formulasPending).toBe(true)
    await releaseLease(app.baseUrl, amySession, document.id, { token: acquired.token, writeEpoch: acquired.writeEpoch, clientInstanceId: randomUUID() })
    // 收齐之后再保存：内容没变（unchanged），标记清掉
    expect(await saved(await save(document, raw, { baseRevision: 2, query: { formulasPending: 'false' } }))).toMatchObject({ revision: 2, unchanged: true })
    expect([await detail(), await status()]).toEqual([false, false])
    // 标记的写法只认 true、false
    expect((await save(document, raw, { baseRevision: 2, query: { formulasPending: '1' } })).status).toBe(400)
  })

  it('US-M3-03 "公式待更新"在内容相同时只清不设：库里的内容已经收齐，又一次捕获没等到收齐、内容相同（公式的结果也相同），标记不变', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId))
    await saved(await save(document, raw))
    expect((await envelopeOf(document.id)).formulasPending).toBe(false)
    expect(await saved(await save(document, raw, { baseRevision: 2, query: { formulasPending: 'true' } }))).toMatchObject({ revision: 2, unchanged: true })
    expect((await envelopeOf(document.id)).formulasPending).toBe(false)
    expect(await receiptsOf(document.id)).toHaveLength(1)
  })

  it('US-M3-03 "公式待更新"计入负载摘要：同一个 requestId 而标记不同是另一个请求（409 REQUEST_ID_CONFLICT）；同样的标记是重放', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId))
    const requestId = randomUUID()
    const first = await saved(await save(document, raw, { requestId, query: { formulasPending: 'true' } }))
    expect(await saved(await save(document, raw, { requestId, query: { formulasPending: 'true' } }))).toEqual(first)
    expect(await errorOf(await save(document, raw, { requestId }))).toMatchObject({ status: 409, code: 'REQUEST_ID_CONFLICT' })
  })

  it('US-M3-03 收齐之后的补存与带标记的那一版内容不同（公式的值算完变了）：照常加修订号，标记清掉；之后又一次带标记的保存（上限又到了）照样记下', async () => {
    const document = await amyDocument()
    // A1 是公式，缓存值是上限到时还没算完的旧值
    const pending = bytesOf(workbookOf(document.unitId, '', withCell({ f: '=1+1', v: 999, t: 2 })))
    expect(await saved(await save(document, pending, { query: { formulasPending: 'true' } }))).toMatchObject({ revision: 2, unchanged: false })
    expect((await envelopeOf(document.id)).formulasPending).toBe(true)
    // 收齐之后的补存：公式的值变了，内容不同
    const settled = bytesOf(workbookOf(document.unitId, '', withCell({ f: '=1+1', v: 2, t: 2 })))
    expect(await saved(await save(document, settled, { baseRevision: 2, query: { formulasPending: 'false' } }))).toMatchObject({ revision: 3, unchanged: false })
    expect(await envelopeOf(document.id)).toMatchObject({ revision: 3, formulasPending: false, contentHash: hashOf(settled) })
    // 又改了公式、上限到了还没算完：带标记的保存照样记下
    const again = bytesOf(workbookOf(document.unitId, '', withCell({ f: '=1+2', v: 2, t: 2 })))
    expect(await saved(await save(document, again, { baseRevision: 3, query: { formulasPending: 'true' } }))).toMatchObject({ revision: 4, unchanged: false })
    expect((await envelopeOf(document.id)).formulasPending).toBe(true)
  })
})

describe('US-M3-02 自动保存的服务端一侧：同一份内容不加修订号（回执），结果未知时原样重发（M3-P3 设计 §3.7；M3-P4 设计 §3.3、§3.7、§3.8）', () => {
  it('US-M3-02 同一份内容连着保存几次（改了又撤销之后、页面还不知道服务端已有它）：每次都是回执——修订号不变、保存时间是那一版的，不写内容、修订记录与审计，每次一条回执', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId, '撤销之后的样子'))
    const first = await saved(await save(document, raw))
    expect(first).toMatchObject({ revision: 2, unchanged: false })
    const before = await envelopeOf(document.id)
    const requestIds = [randomUUID(), randomUUID(), randomUUID()]
    for (const requestId of requestIds)
      expect(await saved(await save(document, raw, { baseRevision: 2, requestId }))).toEqual({ revision: 2, savedAt: first.savedAt, unchanged: true })
    expect(await envelopeOf(document.id)).toEqual(before)
    expect(await revisionsOf(document.id)).toHaveLength(2)
    expect(await auditsOf(document.id)).toBe(1)
    expect((await receiptsOf(document.id)).map(receipt => receipt.request_id)).toEqual(requestIds)
  })

  it('US-M3-02 一段编辑里修订号只随内容的变化增加：变了、没变（回执）、又变、回到更早的内容（与当前的不同，也是变化）——2、2、3、4', async () => {
    const document = await amyDocument()
    const first = bytesOf(workbookOf(document.unitId, '甲'))
    const second = bytesOf(workbookOf(document.unitId, '乙'))
    expect(await saved(await save(document, first))).toMatchObject({ revision: 2, unchanged: false })
    expect(await saved(await save(document, first, { baseRevision: 2 }))).toMatchObject({ revision: 2, unchanged: true })
    expect(await saved(await save(document, second, { baseRevision: 2 }))).toMatchObject({ revision: 3, unchanged: false })
    expect(await saved(await save(document, first, { baseRevision: 3 }))).toMatchObject({ revision: 4, unchanged: false })
    expect((await revisionsOf(document.id)).map(row => row.revision)).toEqual([1, 2, 3, 4])
    expect(await auditsOf(document.id)).toBe(3)
  })

  it('US-M3-02 结果未知的那次自动保存原样重发（同一个 requestId：断网、5xx、503 之后）：拿到原来的结果，不重复写入；内容相同的回执原样重发同样拿到原来的确认、不再写回执', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId, '回包丢了'))
    const requestId = randomUUID()
    const first = await saved(await save(document, raw, { requestId }))
    expect(await saved(await save(document, raw, { requestId }))).toEqual(first)
    expect(await revisionsOf(document.id)).toHaveLength(2)
    expect(await auditsOf(document.id)).toBe(1)
    const receiptId = randomUUID()
    const receipt = await saved(await save(document, raw, { baseRevision: 2, requestId: receiptId }))
    expect(receipt).toMatchObject({ revision: 2, unchanged: true })
    expect(await saved(await save(document, raw, { baseRevision: 2, requestId: receiptId }))).toEqual(receipt)
    expect(await receiptsOf(document.id)).toHaveLength(1)
  })
})

describe('请求的写法：新字段在契约里可选（旧页面的重试要到得了重放），写法不对的照样 400', () => {
  it('查询参数里的格式版本、"公式待更新"写法不对：400；不认识的 Univer 版本、档案按过旧（409），不是 400', async () => {
    const document = await amyDocument()
    const raw = bytesOf(workbookOf(document.unitId))
    expect((await save(document, raw, { query: { formatVersion: '01' } })).status).toBe(400)
    expect((await save(document, raw, { query: { formulasPending: 'yes' } })).status).toBe(400)
    expect(await errorOf(await save(document, raw, { query: { univerVersion: '2.0.0-beta.1' } }))).toMatchObject({ status: 409, code: 'CLIENT_OUTDATED' })
    expect(clientFormatQuery()).toEqual({ clientBuild: CLIENT_BUILD, univerVersion: UNIVER_SDK_VERSION, profile: 'sheet@1', formatVersion: '1' })
  })
})
