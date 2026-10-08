// 编辑租约的仓储发出的语句（M3-P1 设计 §3.3、§3.4.6）：不连数据库（recorded-statements.test-support.ts），核对语句的形状——
// 时间都取数据库的 now()，读出的行带着同一条语句里的 now()，加锁的对象与顺序，收回写入权的范围条件与 coversWriter 逐种同义、
// 第一条连按时间刚死不久的也锁、第二条只交出按时间还活着的（M3-P5 设计 §3.5、审查 A1，边界与有效条件逐一相同）；
// 改写为新的一代时请求、保留与接管标记的沿用与清空（§3.6、§3.7），接管时直接写下接管标记（§3.7、§3.8），最后活动按带来的空闲往前推、续租时只前进；请求编辑的发出、续期、取消、谢绝与交出（§3.6）只改
// 请求、保留与"结束"几列（§3.12：保存不加锁读租约行的论证靠它）；换代与明确结束凭持锁的凭据，语句只用其中的文档 id（Codex 评审 CX1：
// 凭据只在类型上，先锁文档行再锁租约行由服务的单元测试与集成测试核对）。这些语句在真实数据库上的行为（并发与交错、时间、约束）由集成测试覆盖
// （tests/integration 的 documents/edit-leases.test.ts、lease-takeover.test.ts、lease-requests.test.ts、lease-revocation.test.ts 与几个 *-locks.test.ts）。
import type { Transaction } from '../database/index.ts'
import type { DocumentRowLock } from './documents.repository.ts'
import type { LockedEditLease, NewEditLease } from './edit-leases.repository.ts'
import type { RecordedStatement } from './recorded-statements.test-support.ts'
import type { DocumentWriter, WriteAccessScope } from './write-access.ts'
import { Buffer } from 'node:buffer'
import { EDIT_HANDOVER_RESERVE_SECONDS, EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS, EDIT_REQUEST_TTL_SECONDS } from '@nerve-office/contracts'
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
/** 被接管的那一代的令牌摘要（接管标记） */
const TAKEN_DIGEST = Buffer.alloc(32, 9)

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

/**
 * 持锁的凭据（Codex 评审 CX1）：类型上只有锁住它的仓储方法给出；这里只核对语句的形状（语句只用其中的文档 id），照样造一个
 */
function documentLock(id: string): DocumentRowLock {
  return { id } as DocumentRowLock
}

function lockedLease(documentId: string): LockedEditLease {
  return { documentId } as LockedEditLease
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

  it('在文档行的锁下锁租约行（Codex 评审 CX1）：与按文档锁同一条语句，文档 id 取自文档行的凭据；只锁租约行，文档行由调用方先锁', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.lockUnder(documentLock(DOCUMENT), transaction))
    const plain = await onlyStatementOf(async (leases, transaction) => leases.lockByDocument(DOCUMENT, transaction))
    expect(statement).toEqual(plain)
  })
})

describe('改写为新的一代', () => {
  /** 续上的页面带来 37 秒的空闲；不是接管 */
  const lease = { holderId: AMY, sessionId: SESSION, clientInstanceId: TAB, tokenDigest: DIGEST, writeEpoch: 5, idleSeconds: 37, takenOver: undefined }

  /** 改写 DOCUMENT 的租约（文档 id 取自文档行的凭据） */
  async function replaced(takenOver: NewEditLease['takenOver'] = undefined): Promise<RecordedStatement> {
    return onlyStatementOf(async (leases, transaction) => leases.replace(documentLock(DOCUMENT), { ...lease, takenOver }, transaction))
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

  it('M3-P5 接管标记：不是接管时，同一个页面（旧行的登录与标签页都是这一次的）重试才沿用上一代的，否则清空', async () => {
    const statement = await replaced()
    for (const column of TAKEOVER_COLUMNS) {
      const kept = new RegExp(`^case when "document_edit_leases"\\."session_id" = \\$(\\d+) and "document_edit_leases"\\."client_instance_id" = \\$(\\d+) then "document_edit_leases"\\."${column}" end$`).exec(assignmentOf(statement.text, column))
      expect(kept, column).not.toBeNull()
      expect([parameter(statement, kept?.[1]), parameter(statement, kept?.[2])], column).toEqual([SESSION, TAB])
    }
  })

  it.each(['self', 'forced'] as const)('M3-P5 接管（%s）：插入与改写两半都直接写下给出的接管标记——被接管那一代的令牌摘要与方式，不按旧行判断；别的列与不是接管时相同', async (takeover) => {
    const statement = await replaced({ tokenDigest: TAKEN_DIGEST, takeover })
    const plain = await replaced()
    // 插入那一半：最后两列是给出的标记（不是接管时是 default）
    const insert = new RegExp(`^insert into "document_edit_leases" \\(.*${quoted(TAKEOVER_COLUMNS)}\\) values \\(.*, \\$(\\d+), \\$(\\d+)\\) on conflict `).exec(statement.text)
    expect(insert).not.toBeNull()
    expect(insert?.slice(1).map(placeholder => parameter(statement, placeholder))).toEqual([TAKEN_DIGEST, takeover])
    expect(plain.text).toContain(`${HANDOVER_COLUMNS.map(() => 'default').join(', ')}) on conflict`)
    // 改写那一半：标记两列是参数，不是 CASE
    const assigned = TAKEOVER_COLUMNS.map((column) => {
      const value = /^\$(\d+)$/.exec(assignmentOf(statement.text, column))
      expect(value, column).not.toBeNull()
      return parameter(statement, value?.[1])
    })
    expect(assigned).toEqual([TAKEN_DIGEST, takeover])
    // 其余各列的赋值与不是接管时逐列相同（请求按同一个持有者沿用、保留清空）
    for (const column of [...REQUEST_COLUMNS, ...RESERVATION_COLUMNS])
      expect(assignmentOf(statement.text, column).replaceAll(/\$\d+/g, '$'), column).toBe(assignmentOf(plain.text, column).replaceAll(/\$\d+/g, '$'))
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
    const statement = await onlyStatementOf(async (leases, transaction) => leases.end(lockedLease(DOCUMENT), 'released', transaction))
    expect(statement.text).toMatch(/^update "document_edit_leases" set "ended_at" = now\(\), "end_reason" = \$1 where \("document_edit_leases"\."document_id" = \$2 and "document_edit_leases"\."ended_at" is null\)/)
    expect(statement.values).toEqual(['released', DOCUMENT])
  })

  it('一批明确结束（收回写入权）：一条语句，这串文档 id 作为一个数组参数，同样只改还没结束的；没有文档时一条也不发', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.endAll([lockedLease(DOCUMENT), lockedLease(OTHER_DOCUMENT)], 'revoked', transaction))
    expect(statement.text).toBe('update "document_edit_leases" set "ended_at" = now(), "end_reason" = $1 where ("document_edit_leases"."document_id" = ANY($2::uuid[]) and "document_edit_leases"."ended_at" is null)')
    expect(statement.values).toEqual(['revoked', [DOCUMENT, OTHER_DOCUMENT]])
    expect(await statementsOf(async (leases, transaction) => leases.endAll([], 'revoked', transaction))).toEqual([])
  })
})

describe('M3-P5 请求编辑与交出（设计 §3.6、§3.12）：按主键一条语句（调用方已锁住租约行；交出另先锁文档行，Codex 评审 CX1），时间是 now()，只改请求、保留与"结束"这几列', () => {
  /** 一条 update 的 SET 里赋值的列（按出现的顺序） */
  function assignedColumns(text: string): string[] {
    const set = text.slice(text.indexOf(' set ') + ' set '.length, text.indexOf(' where '))
    return [...set.matchAll(/(?:^|, )"([a-z_]+)" = /g)].map(match => match[1] ?? '')
  }

  /**
   * 保存判断有效看的那几列（与持有者、绑定、令牌、代次有关的）：只锁租约行的写路径（请求编辑）都不改它们（仓储的类注释）；
   * 交出凭文档行的锁结束这一代（"结束"两列），同样不改它们
   */
  const GENERATION_COLUMNS = ['holder_id', 'session_id', 'client_instance_id', 'token_digest', 'write_epoch', 'acquired_at', 'renewed_at', 'expires_at', 'last_active_at']

  it('发出新的请求：标识由数据库生成（uuidv7()），请求方与他这次登录是参数，发出是 now()，有效期 now() 加 10 分钟，谢绝清空；按主键，返回标识、发出与有效期', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.putRequest(DOCUMENT, { userId: BEN, sessionId: SESSION }, transaction))
    const matched = /^update "document_edit_leases" set "request_id" = uuidv7\(\), "requested_by" = \$(\d+), "request_session_id" = \$(\d+), "requested_at" = now\(\), "request_expires_at" = now\(\) \+ make_interval\(secs => \$(\d+)\), "request_declined_at" = \$(\d+) where "document_edit_leases"\."document_id" = \$(\d+) returning "request_id", "requested_at", "request_expires_at"$/.exec(statement.text)
    expect(matched).not.toBeNull()
    expect(matched?.slice(1).map(placeholder => parameter(statement, placeholder))).toEqual([BEN, SESSION, EDIT_REQUEST_TTL_SECONDS, null, DOCUMENT])
  })

  it('续期：只把有效期推到 now() 加 10 分钟（标识、请求方、登录、发出的时刻不变）', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.extendRequest(DOCUMENT, transaction))
    expect(statement.text).toBe('update "document_edit_leases" set "request_expires_at" = now() + make_interval(secs => $1) where "document_edit_leases"."document_id" = $2 returning "request_id", "requested_at", "request_expires_at"')
    expect(statement.values).toEqual([EDIT_REQUEST_TTL_SECONDS, DOCUMENT])
  })

  it('取消：请求的六列都清空；清掉保留：保留的两列清空，明确结束（handed_over）不动', async () => {
    const cleared = await onlyStatementOf(async (leases, transaction) => leases.clearRequest(DOCUMENT, transaction))
    expect(assignedColumns(cleared.text)).toEqual(REQUEST_COLUMNS)
    expect(cleared.values).toEqual([...REQUEST_COLUMNS.map(() => null), DOCUMENT])
    expect(cleared.text.endsWith('where "document_edit_leases"."document_id" = $7')).toBe(true)
    const unreserved = await onlyStatementOf(async (leases, transaction) => leases.clearReservation(DOCUMENT, transaction))
    expect(unreserved.text).toBe('update "document_edit_leases" set "reserved_for" = $1, "reserved_until" = $2 where "document_edit_leases"."document_id" = $3')
    expect(unreserved.values).toEqual([null, null, DOCUMENT])
  })

  it('谢绝：只记下谢绝的时刻 now()', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.declineRequest(DOCUMENT, transaction))
    expect(statement.text).toBe('update "document_edit_leases" set "request_declined_at" = now() where "document_edit_leases"."document_id" = $1')
    expect(statement.values).toEqual([DOCUMENT])
  })

  it('交出：一条语句——明确结束（now()、handed_over），保留给改之前的请求方（requested_by 列本身，不是参数）到 now() 加 2 分钟，请求的六列清空；返回保留', async () => {
    const statement = await onlyStatementOf(async (leases, transaction) => leases.handOver(lockedLease(DOCUMENT), transaction))
    expect(assignedColumns(statement.text)).toEqual(['ended_at', 'end_reason', ...REQUEST_COLUMNS, ...RESERVATION_COLUMNS])
    expect(statement.text).toContain('"ended_at" = now(), "end_reason" = $1, ')
    expect(statement.text).toContain(', "reserved_for" = "document_edit_leases"."requested_by", "reserved_until" = now() + make_interval(secs => $8) where "document_edit_leases"."document_id" = $9 returning "reserved_for", "reserved_until"')
    expect(statement.values).toEqual(['handed_over', ...REQUEST_COLUMNS.map(() => null), EDIT_HANDOVER_RESERVE_SECONDS, DOCUMENT])
  })

  it('这几条都不改持有者、登录、标签页、令牌摘要、代次与续租的几项时间（保存不加锁读租约行，请求编辑只锁租约行，靠的就是这一条），语句本身都不加锁、按主键', async () => {
    const statements = await statementsOf(async (leases, transaction) => {
      for (const call of [
        async () => leases.putRequest(DOCUMENT, { userId: BEN, sessionId: SESSION }, transaction),
        async () => leases.extendRequest(DOCUMENT, transaction),
        async () => leases.clearRequest(DOCUMENT, transaction),
        async () => leases.clearReservation(DOCUMENT, transaction),
        async () => leases.declineRequest(DOCUMENT, transaction),
        async () => leases.handOver(lockedLease(DOCUMENT), transaction),
      ])
        await call().catch(() => undefined)
    })
    expect(statements).toHaveLength(6)
    for (const statement of statements) {
      expect(assignedColumns(statement.text).filter(column => GENERATION_COLUMNS.includes(column)), statement.text).toEqual([])
      expect(statement.text, statement.text).not.toContain('for update')
      expect(whereOf(statement.text).replace(/ returning .*$/, ''), statement.text).toMatch(/^"document_edit_leases"\."document_id" = \$\d+$/)
    }
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

describe('收回写入权：范围的条件与 coversWriter 逐种同义，先按文档 id 的顺序锁文档行（连同按时间刚死不久的），再按同样的顺序锁租约行（只交出按时间还活着的）', () => {
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

  /**
   * 认得的条件（值是参数）：按持有者、文档所在的空间、文档筛，与两种时间条件。按顺序认，认出的从条件里去掉再认下一个——
   * "一个有效期之前"的两条写在前面，免得"空闲不满"认出它的开头
   */
  const FILTERS: readonly (readonly [RegExp, string])[] = [
    // 一个有效期之前那一刻按时间还活着（M3-P5 审查 A1：第一条连刚死不久的也锁）：到期晚于 now() 减有效期，最后活动晚于那一刻再减 12 分钟——
    // 都是严格大于，边界与有效条件第 4、5 条相同，只是按那一刻算
    [/"document_edit_leases"\."expires_at" > now\(\) - make_interval\(secs => \$(\d+)\)/g, '一个有效期之前没到期'],
    [/"document_edit_leases"\."last_active_at" > now\(\) - make_interval\(secs => \$(\d+)\) - make_interval\(secs => \$(\d+)\)/g, '一个有效期之前空闲不满'],
    [/"document_edit_leases"\."holder_id" = \$(\d+)/g, '持有者'],
    [/"documents"\."space_id" = \$(\d+)/g, '空间'],
    [/"document_edit_leases"\."document_id" = ANY\(\$(\d+)::uuid\[\]\)/g, '文档'],
    // 按时间还活着（M3-P5，DEF-044）：空闲不满这些秒——严格大于，恰好空闲满 12 分钟算死（与有效条件第 5 条的边界相同）
    [/"document_edit_leases"\."last_active_at" > now\(\) - make_interval\(secs => \$(\d+)\)/g, '空闲不满'],
  ]
  const OPEN = '"document_edit_leases"."ended_at" is null'
  /** 按时间还活着：没到期——严格大于，恰好到期算死（与有效条件第 4 条的边界相同）。在认过"一个有效期之前没到期"之后才认 */
  const NOT_EXPIRED = '"document_edit_leases"."expires_at" > now()'

  /**
   * 语句的条件按哪几项筛、用的是哪些值（另有"没有明确结束""没到期"）。除了认得的这几项（与"and"、括号）还有别的条件时，
   * 原样列出来：多筛一项（例如按文档的创建人）与少筛一项同样是与 coversWriter 不一致；时间条件写成 >= 也认不出
   */
  function filtersOf(statement: RecordedStatement): string[] {
    let rest = whereOf(statement.text)
    const filters: string[] = []
    for (const [pattern, label] of FILTERS) {
      for (const match of rest.matchAll(pattern))
        filters.push(`${label}=${match.slice(1).map(placeholder => String(parameter(statement, placeholder))).join('+')}`)
      rest = rest.replaceAll(pattern, '')
    }
    for (const [text, label] of [[OPEN, '没有明确结束'], [NOT_EXPIRED, '没到期']] as const) {
      if (rest.includes(text))
        filters.push(label)
      rest = rest.replaceAll(text, '')
    }
    rest = rest.replaceAll(/[()]|\band\b/g, '').trim()
    return (rest === '' ? filters : [...filters, `认不出的条件：${rest}`]).sort()
  }

  /** 第一条（锁文档行）要的：没有明确结束、一个有效期之前那一刻按时间还活着（刚死不久的也锁，等在途的保存，M3-P5 审查 A1） */
  const ALIVE_A_TTL_AGO = ['没有明确结束', `一个有效期之前没到期=${EDIT_LEASE_TTL_SECONDS}`, `一个有效期之前空闲不满=${EDIT_LEASE_TTL_SECONDS}+${EDIT_LEASE_IDLE_RECLAIM_SECONDS}`]
  /** 第二条（锁租约行、交给收回写入权）要的：没有明确结束、按时间还活着（没到期、空闲不满 12 分钟） */
  const LIVE = ['没有明确结束', '没到期', `空闲不满=${EDIT_LEASE_IDLE_RECLAIM_SECONDS}`]

  /** 锁文档行的那条语句锁住了 DOCUMENT */
  const lockedDocument = (text: string): unknown[] => text.includes('for update of "documents"') ? [[DOCUMENT]] : []

  it.each(SCOPES.map(scope => [scope.kind, scope] as const))('%s：两条语句的条件都与 coversWriter 判断的同样几项、同样的值；第一条锁没有明确结束、按时间刚死不久或还活着的租约的文档行（M3-P5 审查 A1），第二条只交出按时间还活着的（DEF-044）', async (_kind, scope) => {
    const [documents, leases, ...rest] = await statementsOf(async (repository, transaction) => repository.lockInScope(scope, transaction), lockedDocument)
    expect(rest).toEqual([])
    expect(documents && filtersOf(documents)).toEqual([...coveredBy(scope), ...ALIVE_A_TTL_AGO].sort())
    // 第二条另加"是锁住的那些文档"，范围再核对一次（等文档行的锁时租约可能被改写过），时间条件按 now() 那一刻
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
