// 从每个阶段结束时"有数据的库"一路迁移到最新（M2-P6 复核 B 的 B6）：单个迁移的用例只在它前一个版本上验证自己，
// 这里按当时的结构写入有代表性的数据——每个审计动作、目标类型与来源各一条，会话的每个撤销原因，邀请、重置与限流的行，
// 团队空间（全员可见的、归档的）与成员、写入代次不为 0 的文档，10 层文件夹、两种删除单元与"文件夹的删除单元里还有单独删过的子孙"，
// 单独授权（M2-P5 起），编辑租约（M3-P1 起：一个有效的、一个明确结束的）——迁移到最新之后核对：每张表的行数不变、约束全部已验证、
// 只由服务保证的不变量都成立，迁移之前的删除单元能经接口恢复与永久删除，迁移之前建的文件夹原样重发当初的新建请求是重放
// （0021 在 SQL 里回填的请求摘要与服务算的一致，M2 Codex 评审 CX6）。
//
// 基准是每个阶段结束时的最后一个迁移（11 个），覆盖了到现在为止的每个迁移在有数据的库上的执行；每个基准一个空库，整个文件 3 秒左右。
// 以后的阶段结束时在 BASES 里加上它的最后一个迁移；时长涨得多时，去掉中间被后面的基准完全覆盖的那些（写明理由）
import type pg from 'pg'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { MIGRATIONS_FOLDER, runMigrations } from '@nerve-office/api'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { passwordHashOf } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { invariantViolations } from '../support/invariants.ts'
import { MIGRATION_TAGS, migrationIndexOf, migrationsUpTo, removeMigrationFolders } from '../support/migration-folders.ts'
import { asUser, login } from '../support/session-client.ts'

/** 每个阶段结束时的最后一个迁移（M2-P3 没有迁移）：从它开始写入数据，再迁移到最新 */
const BASES: readonly (readonly [label: string, tag: string])[] = [
  ['M1 结束（v0.1-m1）', '0007_document_unit_id_not_unique'],
  ['M2-P1 结束', '0008_m2_accounts'],
  ['M2-P2 结束', '0009_m2_team_spaces'],
  ['M2-P4 第 1 步之后（文件夹与回收站的表刚建好）', '0010_m2_folders_trash'],
  ['M2-P4 结束', '0013_m2_audit_job_source'],
  ['M2-P6 第 1 片结束', '0015_m2_p6_login_throttle_accounts'],
  ['M2-P6 第 2 片结束', '0017_m2_p6_space_name_key_blanks'],
  // 到 0019 为止的库迁到 0020（单独授权的表、审计的三个动作，M2-P5）。0019 之前的库上还没有授权的表，没有要按当时的结构写的授权行
  ['M2-P6 结束', '0019_m2_p6_write_epoch_monotonic'],
  // M2 的最后一个迁移（v0.1-m2）：有授权、文件夹带请求摘要的库迁到 0022（编辑租约的表，M3-P1）。之前的库上还没有租约的表
  ['M2 结束（v0.1-m2）', '0021_m2_folder_payload_digest'],
  // 有编辑租约（有效的与明确结束的）的库迁到 0023（审计加上另存为副本的动作，按全量重列的 CHECK 重建）及以后
  ['M3-P1 结束', '0022_m3_p1_document_edit_leases'],
  // 审计里有另存为副本的动作的库迁到以后的（M3-P3 起改文档、内容与修订记录的表）
  ['M3-P2 结束', '0023_m3_p2_conflict_copy_audit'],
]

/** 行数要核对的表（某个基准上还没有的表跳过） */
const TABLES = ['users', 'spaces', 'space_members', 'documents', 'document_contents', 'document_revisions', 'document_grants', 'document_edit_leases', 'folders', 'trash_entries', 'audit_events', 'auth_sessions', 'auth_invitations', 'auth_password_resets', 'auth_login_throttles']

const PASSWORD = 'correct horse battery staple'

const databases: TestDatabase[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    await database.drop()
  removeMigrationFolders()
})

/** 到 lastIndex 为止的迁移里，某个枚举 CHECK 最后一次列出的取值（`CHECK ("表"."列" IN (…))` 的写法）：按当时的取值写数据 */
function checkValuesAt(constraint: string, lastIndex: number): string[] {
  let values: string[] = []
  const pattern = new RegExp(`CONSTRAINT "${constraint}" CHECK \\("[a-z_]+"\\."[a-z_]+" IN \\(([^)]*)\\)\\)`, 'g')
  for (const tag of MIGRATION_TAGS.slice(0, lastIndex + 1)) {
    for (const match of readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8').matchAll(pattern))
      values = (match[1] ?? '').split(',').map(value => value.trim().replace(/^'|'$/g, ''))
  }
  if (values.length === 0)
    throw new Error(`到第 ${lastIndex} 个迁移为止没有 ${constraint} 的取值`)
  return values
}

async function one<T>(client: pg.Client, text: string, values: unknown[] = []): Promise<T> {
  const row = (await client.query(text, values)).rows[0] as T | undefined
  if (row === undefined)
    throw new Error(`没有结果：${text}`)
  return row
}

/** 写入的数据里，迁移之后经接口要用到的部分 */
interface Seeded {
  readonly amy: string
  /** P2 起：艾米是空间管理员的团队空间 */
  readonly teamSpace?: string
  /** P4 起：10 层文件夹（第 1 层在前）与三个删除单元 */
  readonly trash?: {
    readonly chain: readonly string[]
    /** 每一层新建时的 requestId（与 chain 一一对应）：迁移之后原样重发新建请求，核对 0021 回填的请求摘要（M2 Codex 评审 CX6） */
    readonly requests: readonly string[]
    /** 第 8 层里单独删掉的一份文档 */
    readonly lone: string
    /** 第 9、10 层（连同里面的文档）一起删掉 */
    readonly nested: string
    /** 第 6、7、8 层（第 8 层里单独删的文档与第 9、10 层留在各自的删除单元里） */
    readonly folder: string
  }
}

/** 按 base 那个版本的结构写入有代表性的数据 */
async function seed(client: pg.Client, base: number): Promise<Seeded> {
  const at = (tag: string): boolean => base >= migrationIndexOf(tag)
  const insertUser = async (username: string, role: string, status = 'active'): Promise<string> => {
    const accounts = at('0008_m2_accounts')
    const { id } = await one<{ id: string }>(
      client,
      accounts
        ? 'INSERT INTO users (username, display_name, password_hash, system_role, status) VALUES ($1, $2, \'$argon2id$old\', $3, $4) RETURNING id'
        : 'INSERT INTO users (username, display_name, password_hash, system_role) VALUES ($1, $2, \'$argon2id$old\', $3) RETURNING id',
      accounts ? [username, `${username} 显示名`, role, status] : [username, `${username} 显示名`, role],
    )
    await client.query('INSERT INTO spaces (type, name, owner_user_id) VALUES (\'personal\', $1, $2)', [`${username} 显示名`, id])
    return id
  }
  const root = await insertUser('root', 'admin')
  const amy = await insertUser('amy', 'member')
  const dan = at('0008_m2_accounts') ? await insertUser('dan', 'member', 'disabled') : undefined
  const personal = await one<{ id: string }>(client, 'SELECT id FROM spaces WHERE owner_user_id = $1', [amy])

  // 文档：内容、修订 1（新建）与修订 2（保存）
  const insertDocument = async (spaceId: string, title: string, extra: { folderId?: string, epoch?: number } = {}): Promise<string> => {
    const unitId = randomUUID()
    const raw = Buffer.from(sheetSnapshotFor(unitId), 'utf8')
    const gzipped = zlib.gzipSync(raw)
    const columns = ['space_id', 'type', 'title', 'created_by', 'unit_id', 'profile', 'format_version', 'sdk_version', 'revision']
    const values: unknown[] = [spaceId, 'sheet', title, amy, unitId, 'sheet@1', 1, '1.0.1', 2]
    if (at('0009_m2_team_spaces')) {
      columns.push('write_epoch')
      values.push(extra.epoch ?? 0)
    }
    if (at('0010_m2_folders_trash')) {
      columns.push('folder_id')
      values.push(extra.folderId ?? null)
    }
    const { id } = await one<{ id: string }>(client, `INSERT INTO documents (${columns.join(', ')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id`, values)
    await client.query('INSERT INTO document_contents (document_id, snapshot, raw_bytes, stored_bytes) VALUES ($1, $2, $3, $4)', [id, gzipped, raw.length, gzipped.length])
    await client.query('INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, saved_by) VALUES ($1, 1, \'created\', $2, sha256(\'c\'), $3)', [id, randomUUID(), amy])
    await client.query(
      'INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, saved_by, client_instance_id, local_seq) VALUES ($1, 2, \'saved\', $2, sha256(\'s\'), $3, $4, 7)',
      [id, randomUUID(), amy, randomUUID()],
    )
    return id
  }
  const personalDocument = await insertDocument(personal.id, '个人空间的文档')

  // 会话：一条有效的，每个撤销原因各一条
  await client.query('INSERT INTO auth_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at) VALUES ($1, sha256(\'live\'), now() + interval \'1 hour\', now() + interval \'1 day\')', [amy])
  for (const reason of checkValuesAt('auth_sessions_revoked_reason_check', base)) {
    await client.query(
      'INSERT INTO auth_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at, revoked_at, revoked_reason) VALUES ($1, sha256($2::bytea), now(), now() + interval \'1 day\', now(), $3)',
      [amy, Buffer.from(`session-${reason}`), reason],
    )
  }

  // 审计：每个动作、每个目标类型、每个来源各至少一条
  const actions = checkValuesAt('audit_events_action_check', base)
  const targets = checkValuesAt('audit_events_target_type_check', base)
  const sources = checkValuesAt('audit_events_source_check', base)
  for (const [index, action] of actions.entries()) {
    const source = sources[index % sources.length] ?? 'cli'
    const target = targets[index % targets.length] ?? null
    await client.query(
      `INSERT INTO audit_events (action, actor_type, actor_id, target_type, target_id, source, request_id, client_ip, details)
       VALUES ($1, 'user', $2, $3, $4, $5, $6, $7, $8)`,
      [action, root, target, target === null ? null : randomUUID(), source, source === 'http' ? 'req' : null, source === 'http' ? '203.0.113.9' : null, { note: 'old' }],
    )
  }
  for (const source of sources)
    await client.query('INSERT INTO audit_events (action, actor_type, source, request_id) VALUES (\'auth.login_failed\', \'anonymous\', $1, $2)', [source, source === 'http' ? 'req' : null])

  // 邀请（待接受、已作废、已接受）、重置（未用、已用）、限流的计数
  if (at('0008_m2_accounts')) {
    await client.query('INSERT INTO auth_invitations (username, display_name, token_hash, created_by, expires_at) VALUES (\'newbie\', \'newbie\', sha256(\'i1\'), $1, now() + interval \'7 days\')', [root])
    await client.query('INSERT INTO auth_invitations (username, display_name, token_hash, created_by, expires_at, revoked_at, revoked_by) VALUES (\'gone\', \'gone\', sha256(\'i2\'), $1, now() + interval \'7 days\', now(), $1)', [root])
    await client.query('INSERT INTO auth_invitations (username, display_name, token_hash, created_by, expires_at, accepted_at, accepted_user_id) VALUES (\'amy\', \'amy\', sha256(\'i3\'), $1, now() + interval \'7 days\', now(), $2)', [root, amy])
    await client.query('INSERT INTO auth_password_resets (user_id, token_hash, created_by, expires_at) VALUES ($1, sha256(\'r1\'), $2, now() + interval \'1 day\')', [amy, root])
    await client.query('INSERT INTO auth_password_resets (user_id, token_hash, created_by, expires_at, used_at) VALUES ($1, sha256(\'r2\'), $2, now() + interval \'1 day\', now())', [amy, root])
  }
  await client.query('INSERT INTO auth_login_throttles (key_hash, failures, window_started_at, locked_until) VALUES (sha256(\'k\'), 0, now(), NULL)')
  if (at('0015_m2_p6_login_throttle_accounts'))
    await client.query('INSERT INTO auth_login_throttles (key_hash, failures, window_started_at, account_hash) VALUES (sha256(\'k2\'), 3, now(), sha256(\'acct\'))')

  if (!at('0009_m2_team_spaces'))
    return { amy }

  // 团队空间：一个正常并全员可见、一个归档；成员；写入代次不为 0 的文档
  const team = await one<{ id: string }>(client, 'INSERT INTO spaces (type, name, created_by, visible_to_all) VALUES (\'team\', \'研发部\', $1, true) RETURNING id', [root])
  const archived = await one<{ id: string }>(client, 'INSERT INTO spaces (type, name, created_by, status) VALUES (\'team\', \'Market  Team\', $1, \'archived\') RETURNING id', [root])
  await client.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, \'admin\'), ($1, $3, \'editor\'), ($4, $2, \'viewer\')', [team.id, amy, root, archived.id])
  const teamDocument = await insertDocument(team.id, '团队空间的文档', { epoch: 3 })
  const archivedDocument = await insertDocument(archived.id, '归档空间的文档', { epoch: 1 })

  // 编辑租约（M3-P1）：团队空间的文档上一个有效的（这一代就是文档现在的代次），归档空间的文档上一个已经释放的（明确结束）
  if (at('0022_m3_p1_document_edit_leases')) {
    await client.query(
      `INSERT INTO document_edit_leases (document_id, holder_id, session_id, client_instance_id, token_digest, write_epoch, acquired_at, renewed_at, expires_at, last_active_at, ended_at, end_reason)
       VALUES ($1, $2, $3, $4, sha256('lease-live'), 3, now() - interval '1 minute', now(), now() + interval '90 seconds', now(), NULL, NULL),
              ($5, $2, $6, $7, sha256('lease-released'), 1, now() - interval '2 hours', now() - interval '1 hour', now() - interval '58 minutes', now() - interval '1 hour', now() - interval '1 hour', 'released')`,
      [teamDocument, amy, randomUUID(), randomUUID(), archivedDocument, randomUUID(), randomUUID()],
    )
  }

  // 单独授权（M2-P5）：个人空间的文档分享给系统管理员（查看者），团队空间的文档分享给停用的人（编辑者，停用不动授权）
  if (at('0020_m2_p5_document_grants') && dan !== undefined) {
    await client.query(
      'INSERT INTO document_grants (document_id, user_id, role, granted_by) VALUES ($1, $2, \'viewer\', $3), ($4, $5, \'editor\', $3)',
      [personalDocument, root, amy, teamDocument, dan],
    )
  }

  if (!at('0010_m2_folders_trash'))
    return { amy, teamSpace: team.id }

  // 文件夹：一条 10 层的链，每层一份文档。0021 起新建时存下请求的摘要：按服务的写法（与 0021 的回填同一个写法）在 SQL 里算，
  // 迁移之后原样重发这些新建请求照样是重放
  const chain: string[] = []
  const requests: string[] = []
  for (let depth = 1; depth <= 10; depth += 1) {
    const requestId = randomUUID()
    const values = [team.id, chain.at(-1) ?? null, `第 ${depth} 层`, amy, depth, requestId]
    const { id } = await one<{ id: string }>(
      client,
      at('0021_m2_folder_payload_digest')
        ? `INSERT INTO folders (space_id, parent_id, name, created_by, depth, request_id, payload_digest)
           VALUES ($1::uuid, $2::uuid, $3::text, $4, $5, $6,
                   sha256(convert_to('folder-created' || E'\\n' || $1::uuid::text || E'\\n' || coalesce($2::uuid::text, '') || E'\\n' || $3::text, 'UTF8'))) RETURNING id`
        : 'INSERT INTO folders (space_id, parent_id, name, created_by, depth, request_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      values,
    )
    chain.push(id)
    requests.push(requestId)
    await insertDocument(team.id, `第 ${depth} 层的文档`, { folderId: id })
  }
  const level = (depth: number): string => chain[depth - 1] ?? ''
  // 删除单元按当时的结构写（0018 之前还有 origin_space_id，0018 删掉）
  const originSpace = !at('0018_m2_p6_trash_entries_origin_space')
  const entry = async (kind: string, originParent: string, title: string): Promise<string> => (await one<{ id: string }>(
    client,
    originSpace
      ? `INSERT INTO trash_entries (space_id, kind, deleted_by, expires_at, origin_space_id, origin_parent_id, title)
         VALUES ($1, $2, $3, now() + interval '30 days', $1, $4, $5) RETURNING id`
      : `INSERT INTO trash_entries (space_id, kind, deleted_by, expires_at, origin_parent_id, title)
         VALUES ($1, $2, $3, now() + interval '30 days', $4, $5) RETURNING id`,
    [team.id, kind, amy, originParent, title],
  )).id
  // 删除单元 1：第 8 层里单独删掉的一份文档
  const loneDocument = await insertDocument(team.id, '单独删的', { folderId: level(8) })
  const lone = await entry('document', level(8), '单独删的')
  await client.query('UPDATE documents SET status = \'trashed\', trash_entry_id = $2, write_epoch = write_epoch + 1 WHERE id = $1', [loneDocument, lone])
  // 删除单元 2：第 9、10 层连同里面的文档
  const nested = await entry('folder', level(8), '第 9 层')
  await client.query('UPDATE folders SET status = \'trashed\', trash_entry_id = $2 WHERE id = ANY($1::uuid[])', [[level(9), level(10)], nested])
  await client.query('UPDATE documents SET status = \'trashed\', trash_entry_id = $2, write_epoch = write_epoch + 1 WHERE folder_id = ANY($1::uuid[])', [[level(9), level(10)], nested])
  // 删除单元 3：之后再删第 6、7、8 层，只带走当时正常状态的；第 8 层里单独删的文档与第 9、10 层留在各自的单元里
  const folder = await entry('folder', level(5), '第 6 层')
  await client.query('UPDATE folders SET status = \'trashed\', trash_entry_id = $2 WHERE id = ANY($1::uuid[])', [[level(6), level(7), level(8)], folder])
  await client.query('UPDATE documents SET status = \'trashed\', trash_entry_id = $2, write_epoch = write_epoch + 1 WHERE folder_id = ANY($1::uuid[]) AND status = \'active\'', [[level(6), level(7), level(8)], folder])
  return { amy, teamSpace: team.id, trash: { chain, requests, lone, nested, folder } }
}

async function rowCounts(client: pg.Client): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of TABLES) {
    if ((await one<{ exists: string | null }>(client, 'SELECT to_regclass($1)::text AS exists', [`public.${table}`])).exists !== null)
      counts[table] = Number((await one<{ count: string }>(client, `SELECT count(*) FROM ${table}`)).count)
  }
  return counts
}

describe('从每个阶段结束时有数据的库迁移到最新（M2-P6 复核 B 的 B6）', () => {
  for (const [label, tag] of BASES) {
    it(`${label}（${tag}）→ 最新：行数不变、约束全部已验证、不变量成立；迁移之前的删除单元能恢复与永久删除`, async () => {
      const base = migrationIndexOf(tag)
      const database = await createTestDatabase({ migrated: false })
      databases.push(database)
      await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo(tag) })
      const seeded = await database.query(async client => seed(client, base))
      const before = await database.query(rowCounts)

      // 基准就是最后一个迁移时（这个阶段刚结束、下一个阶段的迁移还没有写），库已经是最新的，什么也不执行
      const pending = MIGRATION_TAGS.length - base - 1
      expect(await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000 })).toEqual(pending === 0 ? { status: 'current' } : { status: 'applied', applied: pending })
      const after = await database.query(async client => ({
        counts: await rowCounts(client),
        unvalidated: (await client.query<{ conname: string }>('SELECT conname FROM pg_constraint WHERE NOT convalidated')).rows,
        originSpace: (await client.query('SELECT 1 FROM information_schema.columns WHERE table_schema = \'public\' AND table_name = \'trash_entries\' AND column_name = \'origin_space_id\'')).rowCount,
        epochDecrease: await client.query('UPDATE documents SET write_epoch = write_epoch - 1').then(() => undefined, (error: unknown) => error),
      }))
      // 迁移之后才有的表（例如 M1 的库上的 folders）是空的，其余每张表的行数不变
      expect(after.counts).toEqual({ ...Object.fromEntries(Object.keys(after.counts).map(table => [table, 0])), ...before })
      expect(after.unvalidated).toEqual([])
      // 0018 删掉了多余的原空间；0019 之后直接写库减小已有文档的写入代次被拒
      expect(after.originSpace).toBe(0)
      expect(after.epochDecrease).toMatchObject({ code: '23514', constraint: 'documents_write_epoch_monotonic' })

      // 迁移之后照常能用：艾米换上真的密码哈希，登录，列出文档；有回收站的基准上，新建文件夹、恢复与永久删除迁移之前的删除单元
      await database.query(async client => client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await passwordHashOf(PASSWORD), seeded.amy]))
      const app = await startTestApp({ databaseUrl: database.url })
      try {
        const amy = await login(app.baseUrl, 'amy', PASSWORD)
        expect((await asUser(app.baseUrl, amy, '/api/documents')).status).toBe(200)
        const { teamSpace, trash } = seeded
        if (teamSpace !== undefined && trash !== undefined) {
          // 迁移之前建的文件夹（第 1 层在空间的根目录、第 2 层在第 1 层下面）：原样重发当初的新建请求是重放（同一个 id），
          // 说明 0021 在 SQL 里回填的请求摘要与服务按同一个写法算出的一致（M2 Codex 评审 CX6）；载荷不同照样是冲突
          for (const [index, parentId] of [undefined, trash.chain[0]].entries()) {
            const request = { spaceId: teamSpace, ...(parentId === undefined ? {} : { parentId }), name: `第 ${index + 1} 层`, requestId: trash.requests[index] }
            const replayed = await asUser(app.baseUrl, amy, '/api/folders', { method: 'POST', body: request })
            expect(replayed.status, await replayed.clone().text()).toBe(201)
            expect(await replayed.json()).toMatchObject({ id: trash.chain[index], replayed: true })
            expect((await asUser(app.baseUrl, amy, '/api/folders', { method: 'POST', body: { ...request, name: `第 ${index + 1} 层（改）` } })).status).toBe(409)
          }
          // 第 5 层下面再建一个文件夹（第 6 层）
          const created = await asUser(app.baseUrl, amy, '/api/folders', { method: 'POST', body: { spaceId: teamSpace, parentId: trash.chain[4], name: '新的', requestId: randomUUID() } })
          expect(created.status, await created.clone().text()).toBe(201)
          // 单独删的文档：原位置（第 8 层）也在回收站里，回到空间的根目录
          const restored = await asUser(app.baseUrl, amy, `/api/trash/${trash.lone}/restore`, { method: 'POST' })
          expect(restored.status, await restored.clone().text()).toBe(200)
          expect(await restored.json()).toMatchObject({ folderId: null, movedToRoot: true })
          // 恢复第 6–8 层：回到第 5 层下面；留在回收站里的第 9、10 层层数不变
          const folderRestored = await asUser(app.baseUrl, amy, `/api/trash/${trash.folder}/restore`, { method: 'POST' })
          expect(folderRestored.status, await folderRestored.clone().text()).toBe(200)
          // 永久删除第 9、10 层（连同里面的文档）
          const purged = await asUser(app.baseUrl, amy, `/api/trash/${trash.nested}`, { method: 'DELETE' })
          expect(purged.status, await purged.clone().text()).toBe(204)
          const folders = await database.query(async client => (await client.query<{ depth: number, status: string }>(
            'SELECT depth, status FROM folders WHERE space_id = $1 ORDER BY depth, name',
            [teamSpace],
          )).rows)
          expect(folders.map(row => `${row.depth}:${row.status}`)).toEqual(['1:active', '2:active', '3:active', '4:active', '5:active', '6:active', '6:active', '7:active', '8:active'])
          expect(await database.query(async client => (await client.query('SELECT 1 FROM trash_entries')).rowCount)).toBe(0)
        }
      }
      finally {
        await app.close()
      }
      // 只由服务保证的不变量（删除单元不拆散、层数是父的加一等）在迁移与这些操作之后都成立
      expect(await database.query(invariantViolations)).toEqual([])
    })
  }
})
