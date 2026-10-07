// 测试辅助 passLeaseTime 的自测（support/edit-leases.ts，M3-P5 S1）：让时间过去，就是把这份文档的租约行上的每一个时间列往前挪同样的秒数——
// 时间列以库里的为准（document_edit_leases 上全部 timestamptz 列）：以后加了时间列而辅助没有跟上，这里就失败，
// 不会悄悄留下一个不动的时刻（例如请求的有效期、交出之后的保留），让"时间过去了"的用例测的是一个不存在的状态。
// passRequestTime（M3-P5 S4）只挪请求编辑的三个时刻：持有者照常编辑时验证"请求方停止续期 10 分钟就失效"。
import type { PassiveAccount } from './accounts.ts'
import type { TestDatabase } from './database.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPassiveAccount } from './accounts.ts'
import { createTestDatabase } from './database.ts'
import { seedDocument } from './documents.ts'
import { passLeaseTime, passRequestTime } from './edit-leases.ts'

let database: TestDatabase
let holder: PassiveAccount
let requester: PassiveAccount

beforeAll(async () => {
  database = await createTestDatabase()
  holder = await createPassiveAccount(database, { username: 'lease-holder' })
  requester = await createPassiveAccount(database, { username: 'lease-requester' })
})

afterAll(async () => {
  await database.drop()
})

/** document_edit_leases 上全部的时间列（按名称排序） */
async function timeColumns(): Promise<string[]> {
  return database.query(async client => (await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'document_edit_leases' AND data_type = 'timestamp with time zone' ORDER BY column_name`,
  )).rows.map(row => row.column_name))
}

/** 一份文档（代次 1，与租约的这一代相同）上的一行租约：full 时每一列都有值（交出了、留给请求方、带着被谢绝的请求与接管标记），否则只有必填的 */
async function leaseRow(full: boolean): Promise<string> {
  const document = await seedDocument(database, { spaceId: holder.personalSpaceId, createdBy: holder.id, title: full ? '每一列都有值' : '只有必填的' })
  await database.query(async (client) => {
    await client.query('UPDATE documents SET write_epoch = 1 WHERE id = $1', [document.id])
    await client.query(
      `INSERT INTO document_edit_leases (document_id, holder_id, session_id, client_instance_id, token_digest, write_epoch, acquired_at, renewed_at, expires_at, last_active_at)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), sha256('lease'::bytea), 1, now() - interval '5 minutes', now() - interval '10 seconds', now() + interval '80 seconds', now() - interval '1 minute')`,
      [document.id, holder.id],
    )
    if (full) {
      await client.query(
        `UPDATE document_edit_leases SET ended_at = now(), end_reason = 'handed_over', reserved_for = $2, reserved_until = now() + interval '2 minutes',
           request_id = gen_random_uuid(), requested_by = $2, request_session_id = gen_random_uuid(), requested_at = now() - interval '40 seconds',
           request_expires_at = now() + interval '9 minutes', request_declined_at = now() - interval '20 seconds',
           taken_over_token_digest = sha256('old'::bytea), takeover = 'forced'
         WHERE document_id = $1`,
        [document.id, requester.id],
      )
    }
  })
  return document.id
}

/** 这一行的每个时间列（毫秒；空的为 null） */
async function timesOf(documentId: string, columns: readonly string[]): Promise<Record<string, number | null>> {
  const row = await database.query(async client => (await client.query<Record<string, Date | null>>(
    `SELECT ${columns.join(', ')} FROM document_edit_leases WHERE document_id = $1`,
    [documentId],
  )).rows[0])
  if (row === undefined)
    throw new Error(`没有 ${documentId} 的租约行`)
  return Object.fromEntries(columns.map(column => [column, row[column]?.getTime() ?? null]))
}

describe('passLeaseTime', () => {
  it('租约行上的每一个时间列（含明确结束的时刻、请求编辑的发出、有效期与谢绝、交出之后的保留）都往前挪同样的秒数，空的列还是空的；别的文档的不动', async () => {
    const columns = await timeColumns()
    // 0022 的五个与 0025 的四个：库里多了一个时间列，就要在 passLeaseTime 里一起挪
    expect(columns).toEqual(['acquired_at', 'ended_at', 'expires_at', 'last_active_at', 'renewed_at', 'request_declined_at', 'request_expires_at', 'requested_at', 'reserved_until'])
    const full = await leaseRow(true)
    const sparse = await leaseRow(false)
    const other = await leaseRow(true)
    const before = { full: await timesOf(full, columns), sparse: await timesOf(sparse, columns), other: await timesOf(other, columns) }
    expect(Object.values(before.full).every(time => time !== null)).toBe(true)

    await passLeaseTime(database, full, 600)
    await passLeaseTime(database, sparse, 600)
    const moved = (times: Record<string, number | null>) => Object.fromEntries(Object.entries(times).map(([column, time]) => [column, time === null ? null : time - 600_000]))
    expect(await timesOf(full, columns)).toEqual(moved(before.full))
    expect(await timesOf(sparse, columns)).toEqual(moved(before.sparse))
    expect(Object.values(await timesOf(sparse, columns)).filter(time => time === null)).toHaveLength(5)
    expect(await timesOf(other, columns)).toEqual(before.other)
  })
})

describe('passRequestTime（M3-P5 S4）', () => {
  /** 请求编辑的三个时刻：只挪它们 */
  const REQUEST_TIMES = ['request_declined_at', 'request_expires_at', 'requested_at']

  it('只把请求编辑的三个时刻（发出、有效期、谢绝）往前挪，租约本身的时间、明确结束与保留都不动；空的列还是空的，别的文档的不动', async () => {
    const columns = await timeColumns()
    const full = await leaseRow(true)
    const sparse = await leaseRow(false)
    const before = { full: await timesOf(full, columns), sparse: await timesOf(sparse, columns) }
    await passRequestTime(database, full, 600)
    await passRequestTime(database, sparse, 600)
    const moved = Object.fromEntries(Object.entries(before.full).map(([column, time]) => [column, time !== null && REQUEST_TIMES.includes(column) ? time - 600_000 : time]))
    expect(await timesOf(full, columns)).toEqual(moved)
    expect(await timesOf(sparse, columns)).toEqual(before.sparse)
  })
})
