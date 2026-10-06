// 编辑租约的仓储发出的语句（M3-P1 设计 §3.3、§3.4.6）：不连数据库（recorded-statements.test-support.ts），核对语句的形状——
// 时间都取数据库的 now()，读出的行带着同一条语句里的 now()，加锁的对象与顺序，收回写入权的范围条件与 coversWriter 逐种同义。
// 这些语句在真实数据库上的行为（并发与交错、时间的边界、约束）由 S3–S5 的集成测试覆盖。
import type { Transaction } from '../database/index.ts'
import type { RecordedStatement } from './recorded-statements.test-support.ts'
import type { DocumentWriter, WriteAccessScope } from './write-access.ts'
import { Buffer } from 'node:buffer'
import { EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { DocumentsRepository } from './documents.repository.ts'
import { EditLeasesRepository } from './edit-leases.repository.ts'
import { recordStatements } from './recorded-statements.test-support.ts'
import { coversWriter } from './write-access.ts'

const DOCUMENT = '0199a2c4-0000-7000-8000-0000000000d1'
const OTHER_DOCUMENT = '0199a2c4-0000-7000-8000-0000000000d2'
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const SPACE = '0199a2c4-0000-7000-8000-0000000000c1'
const OTHER_SPACE = '0199a2c4-0000-7000-8000-0000000000c2'
const SESSION = '0199a2c4-0000-7000-8000-0000000000e1'
const TAB = '0199a2c4-0000-7000-8000-0000000000f1'
const DIGEST = Buffer.alloc(32, 7)

async function statementsOf(call: (leases: EditLeasesRepository, transaction: Transaction) => Promise<unknown>, respond?: (text: string) => unknown[]): Promise<RecordedStatement[]> {
  return recordStatements(async (executor, transaction) => call(new EditLeasesRepository(executor as ConstructorParameters<typeof EditLeasesRepository>[0]), transaction), respond)
}

/** 唯一的一条语句 */
async function onlyStatementOf(call: (leases: EditLeasesRepository, transaction: Transaction) => Promise<unknown>): Promise<RecordedStatement> {
  const statements = await statementsOf(async (leases, transaction) => call(leases, transaction).catch(() => undefined))
  expect(statements).toHaveLength(1)
  return statements[0] ?? { text: '', values: [] }
}

/** 第 n 个参数（$n） */
function parameter(statement: RecordedStatement, placeholder: string | undefined): unknown {
  return statement.values[Number(placeholder) - 1]
}

/** 外层的 where 到 order by（或语句末尾）之间 */
function whereOf(text: string): string {
  const at = text.indexOf(' where ')
  const end = text.indexOf(' order by ', at)
  return at < 0 ? '' : text.slice(at + ' where '.length, end < 0 ? undefined : end)
}

describe('读与锁：读出的行带着同一条语句里数据库的 now()', () => {
  it('按文档读：不加锁；一条语句里取出整行与 now()', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.findByDocument(DOCUMENT, transaction))
    expect(statement.text).toMatch(/^select .*"end_reason", now\(\) from "document_edit_leases" where "document_edit_leases"\."document_id" = \$1$/)
    expect(statement.values).toEqual([DOCUMENT])
  })

  it('按文档锁：同一条语句加上 FOR UPDATE', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.lockByDocument(DOCUMENT, transaction))
    expect(statement.text).toMatch(/^select .*now\(\) from "document_edit_leases" where "document_edit_leases"\."document_id" = \$1 for update$/)
    expect(statement.values).toEqual([DOCUMENT])
  })
})

describe('改写为新的一代', () => {
  const lease = { documentId: DOCUMENT, holderId: AMY, sessionId: SESSION, clientInstanceId: TAB, tokenDigest: DIGEST, writeEpoch: 5 }

  it('没有就插入、有就整行改写：持有者、登录、标签页、令牌摘要与代次换成新的；申请、续租与最后活动是 now()，到期是 now() 加有效期；明确结束的两列清空', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.replace(lease, transaction))
    // M3-P5 的请求编辑、交出之后的保留与接管标记（迁移 0025）：插入时取默认（空），改写时这里不动它们——S1 里没有写它们的路，
    // 沿用与清空在 S2 接上（M3-P5 设计 §3.6、§3.7）
    const handover = ['request_id', 'requested_by', 'request_session_id', 'requested_at', 'request_expires_at', 'request_declined_at', 'reserved_for', 'reserved_until', 'taken_over_token_digest', 'takeover']
    const columns = new RegExp(`^insert into "document_edit_leases" \\("document_id", "holder_id", "session_id", "client_instance_id", "token_digest", "write_epoch", "acquired_at", "renewed_at", "expires_at", "last_active_at", "ended_at", "end_reason", ${handover.map(column => `"${column}"`).join(', ')}\\) values \\(\\$(\\d+), \\$(\\d+), \\$(\\d+), \\$(\\d+), \\$(\\d+), \\$(\\d+), now\\(\\), now\\(\\), now\\(\\) \\+ make_interval\\(secs => \\$(\\d+)\\), now\\(\\), \\$(\\d+), \\$(\\d+), ${handover.map(() => 'default').join(', ')}\\) on conflict \\("document_id"\\) do update set `).exec(statement.text)
    expect(columns).not.toBeNull()
    expect(columns?.slice(1).map(placeholder => parameter(statement, placeholder))).toEqual([DOCUMENT, AMY, SESSION, TAB, DIGEST, 5, EDIT_LEASE_TTL_SECONDS, null, null])
    const set = /do update set "holder_id" = \$(\d+), "session_id" = \$(\d+), "client_instance_id" = \$(\d+), "token_digest" = \$(\d+), "write_epoch" = \$(\d+), "acquired_at" = now\(\), "renewed_at" = now\(\), "expires_at" = now\(\) \+ make_interval\(secs => \$(\d+)\), "last_active_at" = now\(\), "ended_at" = \$(\d+), "end_reason" = \$(\d+) returning .*now\(\)$/.exec(statement.text)
    expect(set).not.toBeNull()
    expect(set?.slice(1).map(placeholder => parameter(statement, placeholder))).toEqual([AMY, SESSION, TAB, DIGEST, 5, EDIT_LEASE_TTL_SECONDS, null, null])
  })
})

describe('续租与明确结束', () => {
  it('续租：续租是 now()，到期是 now() 加有效期，最后活动是 now() 减空闲秒数、夹在申请的时间与 now() 之间；返回续租之后的行与 now()', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.renew(DOCUMENT, 37, transaction))
    const set = /^update "document_edit_leases" set "renewed_at" = now\(\), "expires_at" = now\(\) \+ make_interval\(secs => \$(\d+)\), "last_active_at" = least\(greatest\(now\(\) - make_interval\(secs => \$(\d+)\), "document_edit_leases"\."acquired_at"\), now\(\)\) where "document_edit_leases"\."document_id" = \$(\d+) returning .*now\(\)$/.exec(statement.text)
    expect(set).not.toBeNull()
    expect(set?.slice(1).map(placeholder => parameter(statement, placeholder))).toEqual([EDIT_LEASE_TTL_SECONDS, 37, DOCUMENT])
  })

  it('明确结束：结束的时间是 now()，记下原因；已经结束的不改（先记下的原因留着）', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.end(DOCUMENT, 'released', transaction))
    expect(statement.text).toMatch(/^update "document_edit_leases" set "ended_at" = now\(\), "end_reason" = \$1 where \("document_edit_leases"\."document_id" = \$2 and "document_edit_leases"\."ended_at" is null\)/)
    expect(statement.values).toEqual(['released', DOCUMENT])
  })

  it('一批明确结束（收回写入权）：一条语句，这串文档 id 作为一个数组参数，同样只改还没结束的；没有文档时一条也不发', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.endAll([DOCUMENT, OTHER_DOCUMENT], 'revoked', transaction))
    expect(statement.text).toBe('update "document_edit_leases" set "ended_at" = now(), "end_reason" = $1 where ("document_edit_leases"."document_id" = ANY($2::uuid[]) and "document_edit_leases"."ended_at" is null)')
    expect(statement.values).toEqual(['revoked', [DOCUMENT, OTHER_DOCUMENT]])
    expect(await statementsOf(async (leases, transaction) => leases.endAll([], 'revoked', transaction))).toEqual([])
  })
})

describe('文档的写入代次加一（申请编辑权、收回写入权，documents 的仓储）', () => {
  it('只给代次加一并带回新的值；更新时间不动（申请编辑权不是修改文档，列表的排序不变），也不看文档的状态', async () => {
    const statements = await recordStatements(async (executor, transaction) => {
      const documents = new DocumentsRepository(executor as ConstructorParameters<typeof DocumentsRepository>[0])
      return documents.advanceWriteEpoch(DOCUMENT, transaction).catch(() => undefined)
    })
    expect(statements.map(statement => statement.text)).toEqual(['update "documents" set "write_epoch" = "documents"."write_epoch" + 1 where "documents"."id" = $1 returning "write_epoch"'])
    expect(statements[0]?.values).toEqual([DOCUMENT])
  })

  it('一批（收回写入权）：一条语句给这些文档的代次各加一，这串 id 作为一个数组参数；更新时间同样不动；没有文档时一条也不发', async () => {
    const statements = await recordStatements(async (executor, transaction) => {
      const documents = new DocumentsRepository(executor as ConstructorParameters<typeof DocumentsRepository>[0])
      await documents.advanceWriteEpochs([], transaction)
      return documents.advanceWriteEpochs([DOCUMENT, OTHER_DOCUMENT], transaction).catch(() => undefined)
    })
    expect(statements.map(statement => statement.text)).toEqual(['update "documents" set "write_epoch" = "documents"."write_epoch" + 1 where "documents"."id" = ANY($1::uuid[]) returning "id"'])
    expect(statements[0]?.values).toEqual([[DOCUMENT, OTHER_DOCUMENT]])
  })
})

describe('收回写入权：范围的条件与 coversWriter 逐种同义，先按文档 id 的顺序锁文档行，再按同样的顺序锁租约行', () => {
  const SCOPES: readonly WriteAccessScope[] = [
    { kind: 'user', userId: AMY },
    { kind: 'membership', userId: AMY, spaceId: SPACE },
    { kind: 'space', spaceId: SPACE },
    { kind: 'documents', documentIds: [DOCUMENT] },
    { kind: 'userDocuments', userId: AMY, documentIds: [DOCUMENT] },
  ]

  /** 一处每种范围都涉及的写入：艾米在 SPACE 里的 DOCUMENT 上 */
  const WRITER: DocumentWriter = { userId: AMY, documentId: DOCUMENT, spaceId: SPACE }

  /** coversWriter 按哪几项判断：从 WRITER 出发，逐项换成别的值，结论变了就是按它判断，判断的值就是范围里给的 */
  function coveredBy(scope: WriteAccessScope): string[] {
    expect(coversWriter(scope, WRITER), scope.kind).toBe(true)
    return [
      ...(coversWriter(scope, { ...WRITER, userId: BEN }) ? [] : [`持有者=${AMY}`]),
      ...(coversWriter(scope, { ...WRITER, spaceId: OTHER_SPACE }) ? [] : [`空间=${SPACE}`]),
      ...(coversWriter(scope, { ...WRITER, documentId: OTHER_DOCUMENT }) ? [] : [`文档=${DOCUMENT}`]),
    ].sort()
  }

  /** 认得的条件：按持有者、文档所在的空间、文档筛（值是参数） */
  const FILTERS: readonly (readonly [RegExp, string])[] = [
    [/"document_edit_leases"\."holder_id" = \$(\d+)/g, '持有者'],
    [/"documents"\."space_id" = \$(\d+)/g, '空间'],
    [/"document_edit_leases"\."document_id" = ANY\(\$(\d+)::uuid\[\]\)/g, '文档'],
  ]
  const OPEN = '"document_edit_leases"."ended_at" is null'

  /**
   * 语句的条件按哪几项筛、用的是哪些值（另有"没有明确结束"）。除了认得的这几项（与"and"、括号）还有别的条件时，
   * 原样列出来：多筛一项（例如按文档的创建人）与少筛一项同样是与 coversWriter 不一致
   */
  function filtersOf(statement: RecordedStatement): string[] {
    const where = whereOf(statement.text)
    const filters = FILTERS.flatMap(([pattern, label]) => [...where.matchAll(pattern)].map(match => `${label}=${String(parameter(statement, match[1]))}`))
    if (where.includes(OPEN))
      filters.push('没有明确结束')
    const rest = FILTERS.reduce((text, [pattern]) => text.replaceAll(pattern, ''), where.replaceAll(OPEN, '')).replaceAll(/[()]|\band\b/g, '').trim()
    return (rest === '' ? filters : [...filters, `认不出的条件：${rest}`]).sort()
  }

  /** 锁文档行的那条语句锁住了 DOCUMENT */
  const lockedDocument = (text: string): unknown[] => text.includes('for update of "documents"') ? [[DOCUMENT]] : []

  it.each(SCOPES.map(scope => [scope.kind, scope] as const))('%s：两条语句的条件都与 coversWriter 判断的同样几项、同样的值，并且只找没有明确结束的租约', async (_kind, scope) => {
    const [documents, leases, ...rest] = await statementsOf(async (repository, transaction) => repository.lockInScope(scope, transaction), lockedDocument)
    expect(rest).toEqual([])
    expect(documents && filtersOf(documents)).toEqual([...coveredBy(scope), '没有明确结束'].sort())
    // 第二条另加"是锁住的那些文档"，范围再核对一次（等文档行的锁时租约可能被改写过）
    expect(leases && filtersOf(leases)).toEqual([...coveredBy(scope), '没有明确结束', `文档=${DOCUMENT}`].sort())
  })

  it('加锁：第一条按文档 id 的顺序只锁文档行，第二条按同样的顺序只锁租约行，并带回 now() 与文档现在所在的空间、创建人与状态', async () => {
    const [documents, leases] = await statementsOf(async (repository, transaction) => repository.lockInScope({ kind: 'space', spaceId: SPACE }, transaction), lockedDocument)
    expect(documents?.text).toMatch(/^select "documents"\."id" from "documents" inner join "document_edit_leases" on "document_edit_leases"\."document_id" = "documents"\."id" where .* order by "documents"\."id" asc for update of "documents"$/)
    expect(leases?.text).toMatch(/^select .*now\(\), "documents"\."space_id", "documents"\."created_by", "documents"\."status" from "document_edit_leases" inner join "documents" on "documents"\."id" = "document_edit_leases"\."document_id" where \("document_edit_leases"\."document_id" = ANY\(\$1::uuid\[\]\) and .* order by "document_edit_leases"\."document_id" asc for update of "document_edit_leases"$/)
    expect(leases?.values[0]).toEqual([DOCUMENT])
  })

  it('第一条什么也没锁住：不发第二条；范围里没有文档（空的 id 列表）：一条也不发', async () => {
    expect(await statementsOf(async (repository, transaction) => repository.lockInScope({ kind: 'user', userId: AMY }, transaction))).toHaveLength(1)
    for (const scope of [{ kind: 'documents', documentIds: [] }, { kind: 'userDocuments', userId: AMY, documentIds: [] }] as const)
      expect(await statementsOf(async (repository, transaction) => repository.lockInScope(scope, transaction)), scope.kind).toEqual([])
  })
})
