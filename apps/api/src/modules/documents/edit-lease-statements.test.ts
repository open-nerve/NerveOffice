// 编辑租约的仓储发出的语句（M3-P1 设计 §3.3、§3.4.6）：不连数据库（recorded-statements.test-support.ts），核对语句的形状——
// 时间都取数据库的 now()，读出的行带着同一条语句里的 now()，加锁的对象与顺序，收回写入权的范围条件与 coversWriter 逐种同义、
// 只找按时间还活着的（M3-P5 设计 §3.5，边界与有效条件逐一相同）；改写为新的一代时请求、保留与接管标记的沿用与清空（§3.6、§3.7），
// 最后活动按带来的空闲往前推、续租时只前进。这些语句在真实数据库上的行为（并发与交错、时间、约束）由集成测试覆盖
// （tests/integration 的 documents/edit-leases.test.ts、lease-revocation.test.ts、lease-revocation-locks.test.ts）。
import type { Transaction } from '../database/index.ts'
import type { RecordedStatement } from './recorded-statements.test-support.ts'
import type { DocumentWriter, WriteAccessScope } from './write-access.ts'
import { Buffer } from 'node:buffer'
import { EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'
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

/** M3-P5 的三组列（迁移 0025）：请求编辑、交出之后的保留、接管标记，按表定义的顺序 */
const REQUEST_COLUMNS = ['request_id', 'requested_by', 'request_session_id', 'requested_at', 'request_expires_at', 'request_declined_at']
const RESERVATION_COLUMNS = ['reserved_for', 'reserved_until']
const TAKEOVER_COLUMNS = ['taken_over_token_digest', 'takeover']
const HANDOVER_COLUMNS = [...REQUEST_COLUMNS, ...RESERVATION_COLUMNS, ...TAKEOVER_COLUMNS]

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

/** 列名的列表写成语句里的样子："a", "b" */
function quoted(columns: readonly string[]): string {
  return columns.map(column => `"${column}"`).join(', ')
}

describe('读与锁：读出的行带着同一条语句里数据库的 now()', () => {
  it('按文档读：不加锁；一条语句里取出整行（含 M3-P5 的请求、保留与接管标记）与 now()', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.findByDocument(DOCUMENT, transaction))
    expect(statement.text.startsWith('select ')).toBe(true)
    expect(statement.text.endsWith(`"end_reason", ${quoted(HANDOVER_COLUMNS)}, now() from "document_edit_leases" where "document_edit_leases"."document_id" = $1`)).toBe(true)
    expect(statement.values).toEqual([DOCUMENT])
  })

  it('按文档锁：同一条语句加上 FOR UPDATE', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.lockByDocument(DOCUMENT, transaction))
    expect(statement.text).toMatch(/^select .*now\(\) from "document_edit_leases" where "document_edit_leases"\."document_id" = \$1 for update$/)
    expect(statement.values).toEqual([DOCUMENT])
  })
})

describe('改写为新的一代', () => {
  /** 续上的页面带来 37 秒的空闲 */
  const lease = { documentId: DOCUMENT, holderId: AMY, sessionId: SESSION, clientInstanceId: TAB, tokenDigest: DIGEST, writeEpoch: 5, idleSeconds: 37 }

  async function replaced(): Promise<RecordedStatement> {
    return onlyStatementOf(async (leases, transaction) => leases.replace(lease, transaction))
  }

  /** 改写那一半（ON CONFLICT DO UPDATE SET）里这一列的赋值：去掉前面的"列 = "，到下一列（或 returning）之前 */
  function assignmentOf(text: string, column: string): string {
    const set = text.slice(text.indexOf(' do update set ') + ' do update set '.length, text.indexOf(' returning '))
    const at = set.indexOf(`"${column}" = `)
    expect(at, column).toBeGreaterThanOrEqual(0)
    const rest = set.slice(at + `"${column}" = `.length)
    const next = rest.search(/, "[a-z_]+" = /)
    return next < 0 ? rest : rest.slice(0, next)
  }

  it('没有就插入、有就整行改写：持有者、登录、标签页、令牌摘要与代次换成新的；申请与续租是 now()，最后活动是 now() 减带来的空闲秒数（M3-P5），到期是 now() 加有效期；明确结束的两列清空', async () => {
    const statement = await replaced()
    // 插入时 M3-P5 的三组列取默认（空）：新的一行没有请求、保留与接管标记
    const insert = new RegExp(`^insert into "document_edit_leases" \\("document_id", "holder_id", "session_id", "client_instance_id", "token_digest", "write_epoch", "acquired_at", "renewed_at", "expires_at", "last_active_at", "ended_at", "end_reason", ${quoted(HANDOVER_COLUMNS)}\\) values \\(\\$(\\d+), \\$(\\d+), \\$(\\d+), \\$(\\d+), \\$(\\d+), \\$(\\d+), now\\(\\), now\\(\\), now\\(\\) \\+ make_interval\\(secs => \\$(\\d+)\\), now\\(\\) - make_interval\\(secs => \\$(\\d+)\\), \\$(\\d+), \\$(\\d+), ${HANDOVER_COLUMNS.map(() => 'default').join(', ')}\\) on conflict \\("document_id"\\) do update set `).exec(statement.text)
    expect(insert).not.toBeNull()
    expect(insert?.slice(1).map(placeholder => parameter(statement, placeholder))).toEqual([DOCUMENT, AMY, SESSION, TAB, DIGEST, 5, EDIT_LEASE_TTL_SECONDS, 37, null, null])
    const set = /do update set "holder_id" = \$(\d+), "session_id" = \$(\d+), "client_instance_id" = \$(\d+), "token_digest" = \$(\d+), "write_epoch" = \$(\d+), "acquired_at" = now\(\), "renewed_at" = now\(\), "expires_at" = now\(\) \+ make_interval\(secs => \$(\d+)\), "last_active_at" = now\(\) - make_interval\(secs => \$(\d+)\), "ended_at" = \$(\d+), "end_reason" = \$(\d+), /.exec(statement.text)
    expect(set).not.toBeNull()
    expect(set?.slice(1).map(placeholder => parameter(statement, placeholder))).toEqual([AMY, SESSION, TAB, DIGEST, 5, EDIT_LEASE_TTL_SECONDS, 37, null, null])
    expect(statement.text.endsWith(`returning "document_id", "holder_id", "session_id", "client_instance_id", "token_digest", "write_epoch", "acquired_at", "renewed_at", "expires_at", "last_active_at", "ended_at", "end_reason", ${quoted(HANDOVER_COLUMNS)}, now()`)).toBe(true)
  })

  it('改写那一半的赋值恰好是这些列：申请的各列、明确结束、请求、保留、接管标记，不多不少（主键不改）', async () => {
    const { text } = await replaced()
    const set = text.slice(text.indexOf(' do update set ') + ' do update set '.length, text.indexOf(' returning '))
    expect([...set.matchAll(/(?:^|, )"([a-z_]+)" = /g)].map(match => match[1])).toEqual(['holder_id', 'session_id', 'client_instance_id', 'token_digest', 'write_epoch', 'acquired_at', 'renewed_at', 'expires_at', 'last_active_at', 'ended_at', 'end_reason', ...HANDOVER_COLUMNS])
  })

  it('M3-P5 请求编辑的六列：旧行的持有者就是新的持有者才沿用（含已谢绝的状态），否则清空——换了别人、新的持有者是请求方，都在这同一条语句里清', async () => {
    const statement = await replaced()
    for (const column of REQUEST_COLUMNS) {
      const kept = new RegExp(`^case when "document_edit_leases"\\."holder_id" = \\$(\\d+) then "document_edit_leases"\\."${column}" end$`).exec(assignmentOf(statement.text, column))
      expect(kept, column).not.toBeNull()
      expect(parameter(statement, kept?.[1]), column).toBe(AMY)
    }
  })

  it('M3-P5 交出之后的保留一律清空：它只在明确结束（handed_over）时有，这条语句清掉了明确结束，必须同时清', async () => {
    const statement = await replaced()
    for (const column of RESERVATION_COLUMNS) {
      const cleared = /^\$(\d+)$/.exec(assignmentOf(statement.text, column))
      expect(cleared, column).not.toBeNull()
      expect(parameter(statement, cleared?.[1]), column).toBeNull()
    }
  })

  it('M3-P5 接管标记：同一个页面（旧行的登录与标签页都是这一次的）重试才沿用上一代的，否则清空', async () => {
    const statement = await replaced()
    for (const column of TAKEOVER_COLUMNS) {
      const kept = new RegExp(`^case when "document_edit_leases"\\."session_id" = \\$(\\d+) and "document_edit_leases"\\."client_instance_id" = \\$(\\d+) then "document_edit_leases"\\."${column}" end$`).exec(assignmentOf(statement.text, column))
      expect(kept, column).not.toBeNull()
      expect([parameter(statement, kept?.[1]), parameter(statement, kept?.[2])], column).toEqual([SESSION, TAB])
    }
  })
})

describe('续租与明确结束', () => {
  it('续租：续租是 now()，到期是 now() 加有效期，最后活动是 now() 减空闲秒数、只前进不后退（不早于这一行原来的最后活动，M3-P5）、不晚于 now()；返回续租之后的行与 now()', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.renew(DOCUMENT, 37, transaction))
    const set = /^update "document_edit_leases" set "renewed_at" = now\(\), "expires_at" = now\(\) \+ make_interval\(secs => \$(\d+)\), "last_active_at" = least\(greatest\(now\(\) - make_interval\(secs => \$(\d+)\), "document_edit_leases"\."last_active_at"\), now\(\)\) where "document_edit_leases"\."document_id" = \$(\d+) returning .*now\(\)$/.exec(statement.text)
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

describe('收回写入权：范围的条件与 coversWriter 逐种同义，只找按时间还活着的，先按文档 id 的顺序锁文档行，再按同样的顺序锁租约行', () => {
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
    // 按时间还活着（M3-P5，DEF-044）：空闲不满这些秒——严格大于，恰好空闲满 12 分钟算死（与有效条件第 5 条的边界相同）
    [/"document_edit_leases"\."last_active_at" > now\(\) - make_interval\(secs => \$(\d+)\)/g, '空闲不满'],
  ]
  const OPEN = '"document_edit_leases"."ended_at" is null'
  /** 按时间还活着：没到期——严格大于，恰好到期算死（与有效条件第 4 条的边界相同） */
  const NOT_EXPIRED = '"document_edit_leases"."expires_at" > now()'

  /**
   * 语句的条件按哪几项筛、用的是哪些值（另有"没有明确结束""没到期"）。除了认得的这几项（与"and"、括号）还有别的条件时，
   * 原样列出来：多筛一项（例如按文档的创建人）与少筛一项同样是与 coversWriter 不一致；时间条件写成 >= 也认不出
   */
  function filtersOf(statement: RecordedStatement): string[] {
    const where = whereOf(statement.text)
    const filters = FILTERS.flatMap(([pattern, label]) => [...where.matchAll(pattern)].map(match => `${label}=${String(parameter(statement, match[1]))}`))
    for (const [text, label] of [[OPEN, '没有明确结束'], [NOT_EXPIRED, '没到期']] as const) {
      if (where.includes(text))
        filters.push(label)
    }
    const rest = FILTERS.reduce((text, [pattern]) => text.replaceAll(pattern, ''), where.replaceAll(OPEN, '').replaceAll(NOT_EXPIRED, '')).replaceAll(/[()]|\band\b/g, '').trim()
    return (rest === '' ? filters : [...filters, `认不出的条件：${rest}`]).sort()
  }

  /** 两条语句都要的：没有明确结束、按时间还活着（没到期、空闲不满 12 分钟） */
  const LIVE = ['没有明确结束', '没到期', `空闲不满=${EDIT_LEASE_IDLE_RECLAIM_SECONDS}`]

  /** 锁文档行的那条语句锁住了 DOCUMENT */
  const lockedDocument = (text: string): unknown[] => text.includes('for update of "documents"') ? [[DOCUMENT]] : []

  it.each(SCOPES.map(scope => [scope.kind, scope] as const))('%s：两条语句的条件都与 coversWriter 判断的同样几项、同样的值，并且只找没有明确结束、按时间还活着的租约（M3-P5，DEF-044）', async (_kind, scope) => {
    const [documents, leases, ...rest] = await statementsOf(async (repository, transaction) => repository.lockInScope(scope, transaction), lockedDocument)
    expect(rest).toEqual([])
    expect(documents && filtersOf(documents)).toEqual([...coveredBy(scope), ...LIVE].sort())
    // 第二条另加"是锁住的那些文档"，范围再核对一次（等文档行的锁时租约可能被改写过）
    expect(leases && filtersOf(leases)).toEqual([...coveredBy(scope), ...LIVE, `文档=${DOCUMENT}`].sort())
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
