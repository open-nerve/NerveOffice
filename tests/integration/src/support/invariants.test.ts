// 数据不变量扫描的自测（M2-P6 复核 B 的 B5）：
// - 阳性对照：每一条不变量都直接写库造一次违反，删库时的扫描一条不落地报出来（查询写错了、永远查不出东西的那一条会在这里露出来），
//   库照样删掉；
// - 阴性对照：经接口也好、直接写库也好，数据一致时扫描什么也不报（整套集成测试每个文件删库时都在扫，这里再明确写一条）。
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
        `INSERT INTO folders (space_id, parent_id, name, created_by, depth, request_id, status, trash_entry_id)
         VALUES ($1, $2, '夹', $3, $4, $5, CASE WHEN $6::uuid IS NULL THEN 'active' ELSE 'trashed' END, $6) RETURNING id`,
        [spaceId, options.parentId ?? null, owner, options.depth ?? (options.parentId === undefined ? 1 : 2), randomUUID(), options.entry ?? null],
      )).rows[0]!.id,
    document: async (spaceId: string, options: { folderId?: string, entry?: string } = {}): Promise<string> =>
      (await client.query<{ id: string }>(
        `INSERT INTO documents (space_id, folder_id, type, title, created_by, unit_id, profile, format_version, sdk_version, status, trash_entry_id)
         VALUES ($1, $2, 'sheet', '文档', $3, gen_random_uuid()::text, 'sheet@1', 1, 'test', CASE WHEN $4::uuid IS NULL THEN 'active' ELSE 'trashed' END, $4) RETURNING id`,
        [spaceId, options.folderId ?? null, owner, options.entry ?? null],
      )).rows[0]!.id,
    entry: async (spaceId: string, kind: 'document' | 'folder', options: { originSpaceId?: string, originParentId?: string } = {}): Promise<string> =>
      (await client.query<{ id: string }>(
        `INSERT INTO trash_entries (space_id, kind, deleted_by, expires_at, origin_space_id, origin_parent_id, title)
         VALUES ($1, $2, $3, now() + interval '30 days', $4, $5, '删掉的') RETURNING id`,
        [spaceId, kind, owner, options.originSpaceId ?? spaceId, options.originParentId ?? null],
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
      // I12：原空间不是它所在的空间
      await w.document(first, { entry: await w.entry(first, 'document', { originSpaceId: second }) })
      // I13：文档的删除单元的原位置不是那份文档的文件夹
      await w.document(first, { entry: await w.entry(first, 'document', { originParentId: shallow }) })
      // I14：文件夹的删除单元的原位置不是根的父文件夹
      await w.folder(first, { entry: await w.entry(first, 'folder', { originParentId: shallow }) })
      // I15：个人空间里有成员
      await client.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, \'editor\')', [owner.personalSpaceId, owner.id])
    })

    const failure = await database.drop().then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toContain('违反了只由服务保证的不变量')
    for (const invariant of Object.keys(INVARIANTS))
      expect(failure?.message, invariant).toContain(`${invariant}：`)
    // 报错之前库已经删掉了：不留下中断的测试库
    const left = await withClient(async client => (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database.name])).rowCount)
    expect(left).toBe(0)
  })

  it('阴性对照：一致的数据（根目录与文件夹里的文档、整单在回收站里的子树与连带的删除单元）什么也不报', async () => {
    const { database, owner, first } = await world()
    const violations = await database.query(async (client) => {
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

  it('逐条用例核对时只报新造出来的：之前已有的行不再报，同一条不变量下新增的行照样报', () => {
    const before = [{ invariant: 'I4 甲', rows: [{ id: 'a' }] }, { invariant: 'I5 乙', rows: [{ id: 'b' }] }]
    const after = [{ invariant: 'I4 甲', rows: [{ id: 'a' }, { id: 'c' }] }, { invariant: 'I5 乙', rows: [{ id: 'b' }] }, { invariant: 'I8 丙', rows: [{ id: 'd' }] }]
    expect(violationsSince(before, after)).toEqual([{ invariant: 'I4 甲', rows: [{ id: 'c' }] }, { invariant: 'I8 丙', rows: [{ id: 'd' }] }])
    expect(violationsSince(after, before)).toEqual([])
  })
})
