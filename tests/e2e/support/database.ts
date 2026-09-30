// E2E 的测试数据：直接写库（没有创建成员的接口；需要一次建很多份文档的列表用例也直接写库）。每个测试建自己的账户，测试之间互不影响。
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, sheetSnapshotFor, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { hash } from '@node-rs/argon2'
import pg from 'pg'
import { e2eDatabaseUrl } from './environment.ts'

export async function withDatabase<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl(), connectionTimeoutMillis: 5_000 })
  await client.connect()
  try {
    return await fn(client)
  }
  finally {
    await client.end()
  }
}

export interface TestUser {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly password: string
  readonly personalSpaceId: string
}

/** 与应用的默认参数相同：登录时不会触发重新哈希 */
const ARGON2_DEFAULTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }

/**
 * 新账户与它的个人空间。用户名带随机后缀：三个浏览器并行跑同一个用例时互不影响。
 * systemRole 为 admin 时建系统管理员（M2-P1 的管理界面用例）：并行的用例各建各的，库里总有不止一个有效的管理员
 */
export async function createUser(prefix: string, displayName = prefix, options: { readonly systemRole?: 'admin' | 'member' } = {}): Promise<TestUser> {
  const username = `${prefix}-${randomBytes(4).toString('hex')}`
  const password = `password-${randomBytes(8).toString('hex')}`
  const passwordHash = await hash(password, ARGON2_DEFAULTS)
  return withDatabase(async (client) => {
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (username, display_name, password_hash, system_role) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, displayName, passwordHash, options.systemRole ?? 'member'],
    )
    const id = user.rows[0]?.id ?? ''
    const space = await client.query<{ id: string }>('INSERT INTO spaces (type, name, owner_user_id) VALUES (\'personal\', $1, $2) RETURNING id', [displayName, id])
    return { id, username, displayName, password, personalSpaceId: space.rows[0]?.id ?? '' }
  })
}

/** 按 unitId 生成快照的 JSON 文本 */
export type SnapshotFor = (unitId: string) => string

/** 写一个文件夹（M2-P4）：直接写库，作为用例的前置数据；parentId 为空时建在空间的根目录下 */
export async function createFolderIn(spaceId: string, createdBy: TestUser, name: string, parentId?: string): Promise<string> {
  return withDatabase(async (client) => {
    const depth = parentId === undefined
      ? 1
      : Number((await client.query<{ depth: number }>('SELECT depth FROM folders WHERE id = $1', [parentId])).rows[0]?.depth ?? 0) + 1
    const result = await client.query<{ id: string }>(
      'INSERT INTO folders (space_id, parent_id, name, created_by, depth, request_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [spaceId, parentId ?? null, name, createdBy.id, depth, randomUUID()],
    )
    return result.rows[0]?.id ?? ''
  })
}

/**
 * 写一份文档：与经接口新建的一致（元数据、快照的内容、修订号 1 的修订记录）。
 * 快照默认是新建时的模板；spaceId 默认是作者的个人空间；folderId 为空时放在空间的根目录（M2-P4）
 */
async function insertDocument(client: pg.Client, owner: TestUser, title: string, snapshotFor: SnapshotFor = sheetSnapshotFor, spaceId = owner.personalSpaceId, folderId?: string): Promise<string> {
  const unitId = randomUUID()
  const raw = Buffer.from(snapshotFor(unitId), 'utf8')
  const snapshot = zlib.gzipSync(raw)
  const digest = createHash('sha256').update(`created\nsheet\n${title}`, 'utf8').digest()
  const result = await client.query<{ id: string }>(
    `WITH document AS (
       INSERT INTO documents (space_id, type, title, created_by, unit_id, profile, format_version, sdk_version, folder_id)
       VALUES ($1, 'sheet', $2, $3, $4, $5, $6, $7, $13) RETURNING id
     ), content AS (
       INSERT INTO document_contents (document_id, snapshot, raw_bytes, stored_bytes) SELECT id, $8, $9, $10 FROM document
     ), revision AS (
       INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, saved_by) SELECT id, 1, 'created', $11, $12, $3 FROM document
     )
     SELECT id FROM document`,
    [spaceId, title, owner.id, unitId, DOCUMENT_PROFILE_OF.sheet, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION, snapshot, raw.length, snapshot.length, randomUUID(), digest, folderId ?? null],
  )
  return result.rows[0]?.id ?? ''
}

export async function createDocument(owner: TestUser, title: string, snapshotFor?: SnapshotFor): Promise<string> {
  return withDatabase(async client => insertDocument(client, owner, title, snapshotFor))
}

/** 一次写入 count 份文档，标题为"<前缀> 1"…"<前缀> count"（需要"加载更多"的用例：超过一页） */
export async function createDocuments(owner: TestUser, titlePrefix: string, count: number): Promise<void> {
  await withDatabase(async (client) => {
    await client.query('BEGIN')
    for (let n = 1; n <= count; n += 1)
      await insertDocument(client, owner, `${titlePrefix} ${n}`)
    await client.query('COMMIT')
  })
}

/**
 * 在指定的空间里写一份文档（团队空间的用例，M2-P2）。快照默认是新建时的模板（只读的用例写样本，M2-P3）；
 * folderId 为空时放在空间的根目录（M2-P4）
 */
export async function createDocumentIn(spaceId: string, author: TestUser, title: string, options: { readonly snapshotFor?: SnapshotFor, readonly folderId?: string } = {}): Promise<string> {
  return withDatabase(async client => insertDocument(client, author, title, options.snapshotFor ?? sheetSnapshotFor, spaceId, options.folderId))
}

export type SpaceRole = 'admin' | 'editor' | 'viewer'

/**
 * 团队空间与成员（M2-P2）：直接写库。名称带随机后缀：团队空间的名称全库唯一，三个浏览器并行跑同一个用例时互不影响。
 * 返回空间的 id 与实际的名称
 */
export async function createTeamSpace(prefix: string, createdBy: TestUser, members: readonly (readonly [TestUser, SpaceRole])[] = [], options: { readonly visibleToAll?: boolean } = {}): Promise<{ readonly id: string, readonly name: string }> {
  const name = `${prefix} ${randomBytes(3).toString('hex')}`
  return withDatabase(async (client) => {
    const space = await client.query<{ id: string }>(
      'INSERT INTO spaces (type, name, created_by, visible_to_all) VALUES (\'team\', $1, $2, $3) RETURNING id',
      [name, createdBy.id, options.visibleToAll ?? false],
    )
    const id = space.rows[0]?.id ?? ''
    for (const [user, role] of members)
      await client.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [id, user.id, role])
    return { id, name }
  })
}

/** 归档团队空间（只改状态：经管理界面归档与它的审计由 US-M2-05 的用例覆盖；这里是只读用例的前置步骤，M2-P3） */
export async function archiveSpace(spaceId: string): Promise<void> {
  await withDatabase(async (client) => {
    await client.query('UPDATE spaces SET status = \'archived\', updated_at = now() WHERE id = $1 AND type = \'team\'', [spaceId])
  })
}

/** 让这个人的全部会话过期（模拟空闲过期） */
export async function expireSessions(user: TestUser): Promise<void> {
  await withDatabase(async (client) => {
    await client.query('UPDATE auth_sessions SET idle_expires_at = now() - interval \'1 second\' WHERE user_id = $1', [user.id])
  })
}
