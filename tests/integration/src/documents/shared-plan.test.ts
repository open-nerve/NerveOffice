// "与我共享"的查询从授权出发（M2-P5 S3）：只要"可访问文档"的授权那一半时（documents.repository.ts 的 accessible），
// 条件里不带恒假的空间那一半。`space_id = ANY('{}') OR EXISTS (授权)` 里的 OR 让规划器没法把 EXISTS 变成半连接，
// 只能扫整张文档表、逐行判断授权（文档越多越慢，与这个人有几条授权无关）；只剩 EXISTS 时从 document_grants 的 (user_id) 索引出发，
// 按主键取回这几份文档。
// 做法：库里放几千份文档、别人的几千条授权，读者只有几条；ANALYZE 之后经接口请求"与我共享"，记下应用实际发出的那条语句与参数
// （support/statement-capture.ts），在测试自己的连接上 EXPLAIN 它，核对计划的形状：文档表不被整张扫，授权表经 (user_id) 索引驱动查询。
// 只核对形状，不核对代价的数字：数字随统计信息浮动，形状反映的是"能不能从授权出发"。
import type { SharedListResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import type { CapturedQuery, StatementCapture } from '../support/statement-capture.ts'
import { DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, sharedListResponseSchema, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser, login } from '../support/session-client.ts'
import { captureStatements } from '../support/statement-capture.ts'

/** 文档的份数、团队空间的个数、别人的授权条数、读者的授权条数 */
const DOCUMENTS = 6000
const SPACES = 30
const OTHERS_GRANTS = 4000
const READER_GRANTS = 3

let database: TestDatabase
let app: TestApp
let capture: StatementCapture
let root: TestAccount
let reader: TestAccount
let readerSession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  capture = captureStatements(database.name)
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  reader = await createAccount(database, { username: 'reader', displayName: '读者' })
  readerSession = await login(app.baseUrl, 'reader', reader.password)
  await database.query(async (client) => {
    await client.query('BEGIN')
    // 团队空间与里面的文档（只写列表要的列：这里只看计划，不打开文档）
    await client.query('INSERT INTO spaces (type, name, created_by) SELECT \'team\', \'计划 \' || g, $1 FROM generate_series(1, $2::int) g', [root.id, SPACES])
    await client.query(
      `INSERT INTO documents (space_id, type, title, created_by, unit_id, profile, format_version, sdk_version, updated_at)
       SELECT s.ids[1 + g % array_length(s.ids, 1)], 'sheet', '文档 ' || g, $1, gen_random_uuid()::text, $2, $3, $4, now() - g * interval '1 second'
       FROM generate_series(1, $5::int) g, (SELECT array_agg(id ORDER BY id) AS ids FROM spaces WHERE type = 'team') s`,
      [root.id, DOCUMENT_PROFILE_OF.sheet, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION, DOCUMENTS],
    )
    // 别人的授权：200 个人，每人 20 份
    await client.query(
      `INSERT INTO users (username, display_name, password_hash, system_role)
       SELECT 'other-' || g, '别人 ' || g, '$argon2id$passive', 'member' FROM generate_series(1, $1::int) g`,
      [OTHERS_GRANTS / 20],
    )
    await client.query(
      `INSERT INTO document_grants (document_id, user_id, role, granted_by)
       SELECT d.id, u.id, 'viewer', $1
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM users WHERE username LIKE 'other-%') u
       JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM documents) d ON d.n BETWEEN (u.n - 1) * 20 + 1 AND u.n * 20`,
      [root.id],
    )
    // 读者的几条授权，散在不同的空间里
    await client.query(
      `INSERT INTO document_grants (document_id, user_id, role, granted_by)
       SELECT id, $1, 'editor', $2 FROM documents ORDER BY id DESC LIMIT $3`,
      [reader.id, root.id, READER_GRANTS],
    )
    await client.query('COMMIT')
    await client.query('ANALYZE documents')
    await client.query('ANALYZE document_grants')
  })
})

afterAll(async () => {
  capture.restore()
  await app.close()
  await database.drop()
})

interface PlanNode {
  readonly 'Node Type': string
  readonly 'Relation Name'?: string
  readonly 'Index Name'?: string
  readonly 'Parent Relationship'?: string
  readonly 'Plans'?: readonly PlanNode[]
}

/** 计划里的每个节点，连同它是否在子计划里（SubPlan、InitPlan：选出的列里的标量子查询在那里，与查询从哪里出发无关） */
function nodesOf(node: PlanNode, inSubPlan = false): { readonly node: PlanNode, readonly inSubPlan: boolean }[] {
  const here = inSubPlan || node['Parent Relationship'] === 'SubPlan' || node['Parent Relationship'] === 'InitPlan'
  return [{ node, inSubPlan: here }, ...(node.Plans ?? []).flatMap(child => nodesOf(child, here))]
}

/** 在测试自己的连接上 EXPLAIN 应用发出的那条语句（同样的参数） */
async function planOf(query: CapturedQuery): Promise<PlanNode> {
  return database.query(async (client) => {
    const result = await client.query<{ 'QUERY PLAN': { readonly Plan: PlanNode }[] }>(`EXPLAIN (FORMAT JSON) ${query.text}`, [...query.values])
    const plan = result.rows[0]?.['QUERY PLAN'][0]?.Plan
    if (plan === undefined)
      throw new Error('EXPLAIN 没有给出计划')
    return plan
  })
}

/** 请求"与我共享"，返回响应与列出文档的那条语句（外层从 documents 选、条件里有授权表的那一条） */
async function listShared(): Promise<{ readonly page: SharedListResponse, readonly listing: CapturedQuery }> {
  const { result, queries } = await capture.during(async () => {
    const response = await asUser(app.baseUrl, readerSession, '/api/shared')
    expect(response.status).toBe(200)
    return parseExact(sharedListResponseSchema, await response.json())
  })
  const listings = queries.filter(query => /from "documents" where /.test(query.text) && /"document_grants"/.test(query.text))
  expect(listings, queries.map(query => query.text).join('\n')).toHaveLength(1)
  const [listing] = listings
  if (listing === undefined)
    throw new Error('没有找到列出文档的语句')
  return { page: result, listing }
}

describe('"与我共享"的查询从授权出发（M2-P5 S3，EXPLAIN 核对）', () => {
  it('前提：库里的文档与授权有分量，读者只有几条授权；"与我共享"恰好列出这几份', async () => {
    const counts = await database.query(async client => (await client.query<{ documents: number, grants: number, mine: number }>(
      'SELECT (SELECT count(*)::int FROM documents) AS documents, (SELECT count(*)::int FROM document_grants) AS grants, (SELECT count(*)::int FROM document_grants WHERE user_id = $1) AS mine',
      [reader.id],
    )).rows[0])
    expect(counts).toEqual({ documents: DOCUMENTS, grants: OTHERS_GRANTS + READER_GRANTS, mine: READER_GRANTS })
    const { page } = await listShared()
    expect(page.items).toHaveLength(READER_GRANTS)
  })

  it('计划：文档表不被整张扫；授权表经 (user_id) 索引驱动查询（不在子计划里），文档按主键取回', async () => {
    const { listing } = await listShared()
    const nodes = nodesOf(await planOf(listing))
    const shape = JSON.stringify(nodes.map(({ node, inSubPlan }) => `${inSubPlan ? '（子计划）' : ''}${node['Node Type']} ${node['Relation Name'] ?? ''} ${node['Index Name'] ?? ''}`))
    // 只剩 EXISTS 时规划器把它变成半连接：从这个人的授权出发
    expect(nodes.some(({ node, inSubPlan }) => !inSubPlan && node['Relation Name'] === 'document_grants' && node['Index Name'] === 'document_grants_user_idx'), shape).toBe(true)
    // 文档表不被整张扫（顺序扫描，或者不带条件地走整个索引），只按主键取回授权里的那几份
    expect(nodes.some(({ node }) => node['Relation Name'] === 'documents' && node['Node Type'] === 'Seq Scan'), shape).toBe(false)
    expect(nodes.filter(({ node }) => node['Relation Name'] === 'documents').map(({ node }) => node['Index Name']), shape).toEqual(['documents_pkey'])
  })
})
