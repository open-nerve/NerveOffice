// 数据不变量扫描的自测（M2-P6 复核 B 的 B5）：
// - 阳性对照：每一条不变量都直接写库造一次违反，删库时的扫描一条不落地报出来（查询写错了、永远查不出东西的那一条会在这里露出来），
//   库照样删掉；
// - 阴性对照：经接口也好、直接写库也好，数据一致时扫描什么也不报（整套集成测试每个文件删库时都在扫，这里再明确写一条）；
// - 结果确定（按整行排序再取前几行），扫描本身出错时库照样删掉（M2-P6 第 3 片复验）。
import type pg from 'pg'
import type { PassiveAccount } from './accounts.ts'
import type { TestDatabase } from './database.ts'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createPassiveAccount } from './accounts.ts'
import { createTestDatabase, withClient } from './database.ts'
import { INVARIANTS, invariantViolations, violationsSince } from './invariants.ts'
import { createTeamSpace } from './spaces.ts'

interface World {
  readonly database: TestDatabase
  readonly owner: PassiveAccount
  readonly first: string
  readonly second: string
}

async function world(): Promise<World> {
  const database = await createTestDatabase()
  const owner = await createPassiveAccount(database, { username: 'owner' })
  const first = await createTeamSpace(database, { name: '甲', createdBy: owner.id })
  const second = await createTeamSpace(database, { name: '乙', createdBy: owner.id })
  return { database, owner, first, second }
}

/** 直接写库的一行：文件夹、文档、删除单元（满足 CHECK 与外键，只摆出要的关系） */
function writer(client: pg.Client, owner: string) {
  return {
    folder: async (spaceId: string, options: { parentId?: string, depth?: number, entry?: string } = {}): Promise<string> =>
      (await client.query<{ id: string }>(
        `INSERT INTO folders (space_id, parent_id, name, created_by, depth, request_id, payload_digest, status, trash_entry_id)
         VALUES ($1, $2, '夹', $3, $4, $5, sha256(''::bytea), CASE WHEN $6::uuid IS NULL THEN 'active' ELSE 'trashed' END, $6) RETURNING id`,
        [spaceId, options.parentId ?? null, owner, options.depth ?? (options.parentId === undefined ? 1 : 2), randomUUID(), options.entry ?? null],
      )).rows[0]!.id,
    document: async (spaceId: string, options: { folderId?: string, entry?: string } = {}): Promise<string> =>
      (await client.query<{ id: string }>(
        `INSERT INTO documents (space_id, folder_id, type, title, created_by, unit_id, profile, format_version, sdk_version, status, trash_entry_id)
         VALUES ($1, $2, 'sheet', '文档', $3, gen_random_uuid()::text, 'sheet@1', 1, 'test', CASE WHEN $4::uuid IS NULL THEN 'active' ELSE 'trashed' END, $4) RETURNING id`,
        [spaceId, options.folderId ?? null, owner, options.entry ?? null],
      )).rows[0]!.id,
    entry: async (spaceId: string, kind: 'document' | 'folder', options: { originParentId?: string } = {}): Promise<string> =>
      (await client.query<{ id: string }>(
        `INSERT INTO trash_entries (space_id, kind, deleted_by, expires_at, origin_parent_id, title)
         VALUES ($1, $2, $3, now() + interval '30 days', $4, '删掉的') RETURNING id`,
        [spaceId, kind, owner, options.originParentId ?? null],
      )).rows[0]!.id,
  }
}

describe('数据不变量的扫描（M2-P6 复核 B 的 B5）', () => {
  it('阳性对照：每一条不变量各造一次违反，删库时全部报出来，库照样删掉', async () => {
    const { database, owner, first, second } = await world()
    await database.query(async (client) => {
      const w = writer(client, owner.id)
      // I1：子文件夹在别的空间里
      const parent = await w.folder(first)
      await w.folder(second, { parentId: parent })
      // I2：层数不是父文件夹的加一
      const shallow = await w.folder(first)
      await w.folder(first, { parentId: shallow, depth: 3 })
      // I3：文档在别的空间的文件夹里
      await w.document(second, { folderId: shallow })
      // I4、I5：回收站里的文件夹下面有正常状态的文件夹与文档
      const trashedEntry = await w.entry(first, 'folder')
      const trashed = await w.folder(first, { entry: trashedEntry })
      await w.folder(first, { parentId: trashed })
      await w.document(first, { folderId: trashed })
      // I6：删除单元里的文档在别的空间里
      await w.document(second, { entry: await w.entry(first, 'document') })
      // I7：删除单元里的文件夹在别的空间里
      await w.folder(second, { entry: await w.entry(first, 'folder') })
      // I8：空的删除单元（它同时违反 I9）
      await w.entry(first, 'document')
      // I9：文档的删除单元里有两份文档
      const twice = await w.entry(first, 'document')
      await w.document(first, { entry: twice })
      await w.document(first, { entry: twice })
      // I10：文件夹的删除单元有两个根
      const twoRoots = await w.entry(first, 'folder')
      await w.folder(first, { entry: twoRoots })
      await w.folder(first, { entry: twoRoots })
      // I11：文件夹的删除单元里的文档不在同一单的文件夹里
      const loose = await w.entry(first, 'folder')
      await w.folder(first, { entry: loose })
      await w.document(first, { entry: loose })
      // I13：文档的删除单元的原位置不是那份文档的文件夹
      await w.document(first, { entry: await w.entry(first, 'document', { originParentId: shallow }) })
      // I14：文件夹的删除单元的原位置不是根的父文件夹
      await w.folder(first, { entry: await w.entry(first, 'folder', { originParentId: shallow }) })
      // I15：个人空间里有成员
      await client.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, \'editor\')', [owner.personalSpaceId, owner.id])
      // I16：租约的代次比文档的代次大（文档的代次是 0）
      await client.query(
        `INSERT INTO document_edit_leases (document_id, holder_id, session_id, client_instance_id, token_digest, write_epoch, acquired_at, renewed_at, expires_at, last_active_at)
         VALUES ($1, $2, $3, $4, sha256('lease'::bytea), 5, now(), now(), now() + interval '90 seconds', now())`,
        [await w.document(first), owner.id, randomUUID(), randomUUID()],
      )
      // I17：当前修订（修订号 1）的记录带着一个内容哈希，内容上是另一个
      const hashed = await w.document(first)
      await client.query(
        `INSERT INTO document_contents (document_id, snapshot, raw_bytes, stored_bytes, content_hash, resource_names) VALUES ($1, '\\x00'::bytea, 1, 1, sha256('a'::bytea), '{}')`,
        [hashed],
      )
      await client.query(
        `INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, saved_by, content_hash) VALUES ($1, 1, 'created', $2, sha256('c'::bytea), $3, sha256('b'::bytea))`,
        [hashed, randomUUID(), owner.id],
      )
      // I18：回执的修订号比文档的大（文档的修订号是 1）
      await client.query(
        `INSERT INTO document_save_receipts (request_id, document_id, revision, payload_digest, saved_by, saved_at) VALUES ($1, $2, 5, sha256('r'::bytea), $3, now())`,
        [randomUUID(), await w.document(first), owner.id],
      )
      // I19：本机密钥缺了第 2 版（第 1 版吊销了，当前的是第 3 版）；I20：吊销了第 1 版却没有下一版（这个人没有当前的）
      const gap = await createPassiveAccount(database, { username: 'gap' })
      const noCurrent = await createPassiveAccount(database, { username: 'no-current' })
      const material = 'decode(repeat(\'ab\', 16), \'hex\'), decode(repeat(\'cd\', 60), \'hex\')'
      await client.query(`INSERT INTO user_local_keys (user_id, version, revoked_at) VALUES ($1, 1, now()), ($2, 1, now())`, [gap.id, noCurrent.id])
      await client.query(`INSERT INTO user_local_keys (user_id, version, master_key_id, wrapped_key) VALUES ($1, 3, ${material})`, [gap.id])
      // I21：第 2 版的生成时刻不是第 1 版被吊销的那一刻（比它早：吊销取了事务开始的时刻、下一版跟着取了它的情形）
      const drift = await createPassiveAccount(database, { username: 'drift' })
      await client.query(
        `INSERT INTO user_local_keys (user_id, version, master_key_id, wrapped_key, created_at, revoked_at)
         VALUES ($1, 1, NULL, NULL, now() - interval '2 hours', now() - interval '1 hour'), ($1, 2, ${material}, now() - interval '2 hours', NULL)`,
        [drift.id],
      )
    })

    const failure = await database.drop().then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toContain('违反了只由服务保证的不变量')
    for (const invariant of Object.keys(INVARIANTS))
      expect(failure?.message, invariant).toContain(`${invariant}：`)
    // 报错之前库已经删掉了：不留下中断的测试库
    const left = await withClient(async client => (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database.name])).rowCount)
    expect(left).toBe(0)
  })

  it('阴性对照：一致的数据（根目录与文件夹里的文档、整单在回收站里的子树与连带的删除单元，吊销过两次的本机密钥）什么也不报', async () => {
    const { database, owner, first } = await world()
    const violations = await database.query(async (client) => {
      // 本机密钥：第 1、2 版吊销了（材料已擦），第 3 版是当前的；每一版生成于上一版被吊销的那一刻（同一条语句里的 now() 是同一个值）
      await client.query(
        `INSERT INTO user_local_keys (user_id, version, master_key_id, wrapped_key, created_at, revoked_at)
         VALUES ($1, 1, NULL, NULL, now() - interval '3 hours', now() - interval '2 hours'), ($1, 2, NULL, NULL, now() - interval '2 hours', now() - interval '1 hour'),
                ($1, 3, decode(repeat('ab', 16), 'hex'), decode(repeat('cd', 60), 'hex'), now() - interval '1 hour', NULL)`,
        [owner.id],
      )
      const w = writer(client, owner.id)
      const top = await w.folder(first)
      const child = await w.folder(first, { parentId: top })
      await w.document(first)
      await w.document(first, { folderId: child })
      // 一个文件夹的删除单元：根与它的子文件夹、里面的文档；子树里早先单独删过的一份文档自成一单（原位置是它的文件夹）
      const entry = await w.entry(first, 'folder', { originParentId: top })
      const root = await w.folder(first, { parentId: top, entry })
      const inside = await w.folder(first, { parentId: root, depth: 3, entry })
      await w.document(first, { folderId: inside, entry })
      await w.document(first, { folderId: inside, entry: await w.entry(first, 'document', { originParentId: inside }) })
      return invariantViolations(client)
    })
    expect(violations).toEqual([])
    await database.drop()
  })

  it('一条不变量违反的行比列出的上限多：按整行排序取前几行，每次扫出来的都一样（M2-P6 第 3 片复验）', async () => {
    const { database, owner, first } = await world()
    const result = await database.query(async (client) => {
      // I8：七个空的删除单元（每个同时违反 I9）。按 id 从大到小写入：不排序时取到的是先写入的那几个（id 最大的），排了序才是最小的几个
      const entries = Array.from({ length: 7 }, () => randomUUID()).toSorted().toReversed()
      for (const id of entries) {
        await client.query(
          `INSERT INTO trash_entries (id, space_id, kind, deleted_by, expires_at, title) VALUES ($1, $2, 'document', $3, now() + interval '30 days', '空的')`,
          [id, first, owner.id],
        )
      }
      const scans = [await invariantViolations(client), await invariantViolations(client)]
      await client.query('DELETE FROM trash_entries WHERE id = ANY($1::uuid[])', [entries])
      return { entries, scans }
    })
    const [firstScan, secondScan] = result.scans
    expect(secondScan).toEqual(firstScan)
    const empty = firstScan?.find(violation => violation.invariant.startsWith('I8 '))
    expect(empty?.rows.map(row => row.id)).toEqual(result.entries.toSorted().slice(0, 5))
    await database.drop()
  })

  it('每条查询都先按整行排序、再取前几行：不靠执行计划碰巧给出的顺序（上一条的数据量下，不排序的计划也常常恰好有序）', async () => {
    const queries: string[] = []
    const recording = { query: async (text: string) => {
      queries.push(text)
      return { rows: [] }
    } }
    expect(await invariantViolations(recording as unknown as pg.Client)).toEqual([])
    expect(queries).toHaveLength(Object.keys(INVARIANTS).length)
    for (const [index, query] of queries.entries())
      expect(query, Object.keys(INVARIANTS)[index]).toMatch(/^SELECT \* FROM \([\s\S]+\) AS violation ORDER BY violation LIMIT 5$/)
  })

  it('扫描本身出错（例如有一张表不见了）：库照样删掉，再把扫描的错误抛出来', async () => {
    const { database } = await world()
    await database.query(async client => client.query('DROP TABLE trash_entries CASCADE'))
    const failure = await database.drop().then(() => undefined, (error: unknown) => error as { code?: string })
    // 42P01：表不存在（扫描的查询失败），不是"库不存在"
    expect(failure?.code).toBe('42P01')
    const left = await withClient(async client => (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database.name])).rowCount)
    expect(left).toBe(0)
  })

  it('逐条用例核对时只报新造出来的：之前已有的行不再报，同一条不变量下新增的行照样报', () => {
    const before = [{ invariant: 'I4 甲', rows: [{ id: 'a' }] }, { invariant: 'I5 乙', rows: [{ id: 'b' }] }]
    const after = [{ invariant: 'I4 甲', rows: [{ id: 'a' }, { id: 'c' }] }, { invariant: 'I5 乙', rows: [{ id: 'b' }] }, { invariant: 'I8 丙', rows: [{ id: 'd' }] }]
    expect(violationsSince(before, after)).toEqual([{ invariant: 'I4 甲', rows: [{ id: 'c' }] }, { invariant: 'I8 丙', rows: [{ id: 'd' }] }])
    expect(violationsSince(after, before)).toEqual([])
  })
})
