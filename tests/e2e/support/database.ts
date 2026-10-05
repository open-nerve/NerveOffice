// E2E 的测试数据：直接写库（没有创建成员的接口；需要一次建很多份文档的列表用例也直接写库）。每个测试建自己的账户，测试之间互不影响。
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { canonicalContentText, checkResources, contentHashInput, DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, sheetSnapshotFor, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
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
      // 直接写库的文件夹没有新建请求：请求摘要给空串的摘要，与任何请求都对不上（M2 Codex 评审 CX6）
      'INSERT INTO folders (space_id, parent_id, name, created_by, depth, request_id, payload_digest) VALUES ($1, $2, $3, $4, $5, $6, sha256(\'\'::bytea)) RETURNING id',
      [spaceId, parentId ?? null, name, createdBy.id, depth, randomUUID()],
    )
    return result.rows[0]?.id ?? ''
  })
}

/** 写进 document_contents 的一份内容：gzip 压缩的快照、解压之后的字节数与信封 */
interface StoredContent {
  readonly snapshot: Buffer
  readonly rawBytes: number
  /** 规范化内容的 SHA-256（M3-P3 设计 §3.4）；资源过不了检查时为 null（见 storedContent） */
  readonly contentHash: Buffer | null
  /** 非空的资源名，按名称排序；与 contentHash 同时为 null */
  readonly resourceNames: readonly string[] | null
}

/**
 * 一份快照写进库里的样子，与经接口写入的一样（M3-P3 设计 §3.4 的信封）：内容哈希是 contracts 的规范化内容的 SHA-256，资源名是检查之后
 * 非空的那些（服务端在快照检查里算出同样的两项，"内容相同不递增"与不缩水按它们）。资源过不了检查的快照经接口写不进去，两项都为空
 * （按存量处理：哈希为空时下一次保存按"不同"，不缩水解析存下的快照）
 */
function storedContent(text: string): StoredContent {
  const raw = Buffer.from(text, 'utf8')
  const resources = checkResources((JSON.parse(text) as { resources?: unknown }).resources, DOCUMENT_PROFILE_OF.sheet)
  return {
    snapshot: zlib.gzipSync(raw),
    rawBytes: raw.length,
    contentHash: resources.ok ? createHash('sha256').update(contentHashInput(canonicalContentText(text))).digest() : null,
    resourceNames: resources.ok ? resources.nonEmpty : null,
  }
}

/**
 * 写一份文档：与经接口新建的一致（元数据、快照的内容与信封、修订号 1 的修订记录）。
 * 快照默认是新建时的模板；spaceId 默认是作者的个人空间；folderId 为空时放在空间的根目录（M2-P4）
 */
async function insertDocument(client: pg.Client, owner: TestUser, title: string, snapshotFor: SnapshotFor = sheetSnapshotFor, spaceId = owner.personalSpaceId, folderId?: string): Promise<string> {
  const unitId = randomUUID()
  const content = storedContent(snapshotFor(unitId))
  const digest = createHash('sha256').update(`created\nsheet\n${title}`, 'utf8').digest()
  const result = await client.query<{ id: string }>(
    `WITH document AS (
       INSERT INTO documents (space_id, type, title, created_by, unit_id, profile, format_version, sdk_version, folder_id)
       VALUES ($1, 'sheet', $2, $3, $4, $5, $6, $7, $13) RETURNING id
     ), content AS (
       INSERT INTO document_contents (document_id, snapshot, raw_bytes, stored_bytes, content_hash, resource_names)
       SELECT id, $8, $9, $10, $14, $15 FROM document
     ), revision AS (
       INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, saved_by, content_hash)
       SELECT id, 1, 'created', $11, $12, $3, $14 FROM document
     )
     SELECT id FROM document`,
    [spaceId, title, owner.id, unitId, DOCUMENT_PROFILE_OF.sheet, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION, content.snapshot, content.rawBytes, content.snapshot.length, randomUUID(), digest, folderId ?? null, content.contentHash, content.resourceNames],
  )
  return result.rows[0]?.id ?? ''
}

/**
 * 直接写库存一版新的内容（另一个人在别处保存，作为用例的前置数据）：内容与信封、修订号加一、一条修订记录，与经接口保存写出的一样
 * （修订记录的来源是一个新的标签页；没有页面的构建）。edit 就地改解析之后的快照；返回新的修订号。
 * 不经保存接口的理由在用它的地方（例如样本的 data: 图片过不了服务端的快照检查，measure-scene.ts）
 */
export async function writeVersion(documentId: string, savedBy: TestUser, edit: (snapshot: Record<string, unknown>) => void): Promise<number> {
  return withDatabase(async (client) => {
    await client.query('BEGIN')
    try {
      const current = (await client.query<{ revision: number, snapshot: Buffer }>(
        'SELECT d.revision, c.snapshot FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1 FOR UPDATE OF d, c',
        [documentId],
      )).rows[0]
      if (current === undefined)
        throw new Error(`库里没有文档 ${documentId}`)
      const snapshot = JSON.parse(zlib.gunzipSync(current.snapshot).toString('utf8')) as Record<string, unknown>
      edit(snapshot)
      const content = storedContent(JSON.stringify(snapshot))
      const revision = current.revision + 1
      await client.query(
        `UPDATE document_contents SET snapshot = $2, raw_bytes = $3, stored_bytes = $4, content_hash = $5, resource_names = $6, updated_at = now()
         WHERE document_id = $1`,
        [documentId, content.snapshot, content.rawBytes, content.snapshot.length, content.contentHash, content.resourceNames],
      )
      await client.query('UPDATE documents SET revision = $2, updated_at = now() WHERE id = $1', [documentId, revision])
      await client.query(
        `INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, client_instance_id, local_seq, saved_by, content_hash)
         VALUES ($1, $2, 'saved', $3, $4, $5, 1, $6, $7)`,
        [documentId, revision, randomUUID(), randomBytes(32), randomUUID(), savedBy.id, content.contentHash],
      )
      await client.query('COMMIT')
      return revision
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
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

/** 把这个人移出团队空间（直接写库：编辑器页失去权限的用例，M2-P6 复核 S8；经成员页移出由 US-M2-06 的用例覆盖） */
export async function removeMember(spaceId: string, user: TestUser): Promise<void> {
  await withDatabase(async (client) => {
    await client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, user.id])
  })
}

/**
 * 单独授权（M2-P5）：直接写库，作为用例的前置数据——经分享对话框设置、调整与取消由 US-M2-10 的分享用例覆盖。
 * grantedBy 是设置它的人，不能是被授权人自己（表上的 CHECK）
 */
export async function grantDocument(documentId: string, user: TestUser, role: 'viewer' | 'editor', grantedBy: TestUser): Promise<void> {
  await withDatabase(async (client) => {
    await client.query(
      `INSERT INTO document_grants (document_id, user_id, role, granted_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, updated_at = now()`,
      [documentId, user.id, role, grantedBy.id],
    )
  })
}

/** 取消单独授权（直接写库：删行，与取消分享的接口写出的一样），作为用例的前置数据——经对话框取消由 US-M2-10 的分享用例覆盖 */
export async function revokeGrant(documentId: string, user: TestUser): Promise<void> {
  await withDatabase(async (client) => {
    await client.query('DELETE FROM document_grants WHERE document_id = $1 AND user_id = $2', [documentId, user.id])
  })
}

/** 文档现在的修订号（直接查库）：核对被拒绝的保存什么也没存进去，不必有读这份文档的权限 */
export async function revisionOf(documentId: string): Promise<number | undefined> {
  return withDatabase(async client => (await client.query<{ revision: number }>('SELECT revision FROM documents WHERE id = $1', [documentId])).rows[0]?.revision)
}

/** 这份文档上的单独授权（被授权人的登录名 → 角色）：核对经界面的分享、调整与取消确实写进了库（用例的前提） */
export async function grantsOn(documentId: string): Promise<Record<string, string>> {
  return withDatabase(async (client) => {
    const result = await client.query<{ username: string, role: string }>(
      'SELECT u.username, g.role FROM document_grants g JOIN users u ON u.id = g.user_id WHERE g.document_id = $1 ORDER BY u.username',
      [documentId],
    )
    return Object.fromEntries(result.rows.map(row => [row.username, row.role]))
  })
}

/** 让这个人的全部会话过期（模拟空闲过期） */
export async function expireSessions(user: TestUser): Promise<void> {
  await withDatabase(async (client) => {
    await client.query('UPDATE auth_sessions SET idle_expires_at = now() - interval \'1 second\' WHERE user_id = $1', [user.id])
  })
}

/**
 * 让这份文档的编辑租约到期（M3-P1）：改写租约行的时间，不等真实的 90 秒——续租与最后活动在 100 秒前，到期在 10 秒前；
 * 申请的时间也挪到续租之前。表上的 CHECK 照样成立（到期晚于续租、最后活动不晚于续租）。
 * 前提是这份文档有一份没有明确结束的租约（有人在编辑器里打开着它），没有时报错，免得用例的前提悄悄落空
 */
export async function expireEditLease(documentId: string): Promise<void> {
  await withDatabase(async (client) => {
    const result = await client.query(
      `UPDATE document_edit_leases SET renewed_at = now() - interval '100 seconds', last_active_at = now() - interval '100 seconds',
         acquired_at = least(acquired_at, now() - interval '100 seconds'), expires_at = now() - interval '10 seconds'
       WHERE document_id = $1 AND ended_at IS NULL`,
      [documentId],
    )
    if (result.rowCount !== 1)
      throw new Error(`文档 ${documentId} 没有正在进行的编辑租约`)
  })
}

/** 这份文档的编辑租约明确结束的原因（released、revoked）；还没有结束时为 null，从没有过租约时为 undefined */
export async function editLeaseEndReason(documentId: string): Promise<string | null | undefined> {
  return withDatabase(async client => (await client.query<{ end_reason: string | null }>('SELECT end_reason FROM document_edit_leases WHERE document_id = $1', [documentId])).rows[0]?.end_reason)
}

/** 这份文档现在的编辑租约是第几代（每次申请加一）；从没有过租约时为 undefined。核对页面确实重新申请过（续上） */
export async function editLeaseEpoch(documentId: string): Promise<number | undefined> {
  return withDatabase(async client => (await client.query<{ write_epoch: number }>('SELECT write_epoch FROM document_edit_leases WHERE document_id = $1', [documentId])).rows[0]?.write_epoch)
}
