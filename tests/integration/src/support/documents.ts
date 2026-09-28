// 测试数据：直接写库建文档，与经接口新建的一致（元数据、模板快照的内容、修订号 1 的修订记录）。
// 需要控制更新时间的用例（列表的排序与分页）用它；其余的用例经接口新建。
import type { TestDatabase } from './database.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, sheetSnapshotFor, UNIVER_SDK_VERSION } from '@nerve-office/contracts'

export interface DocumentOptions {
  readonly spaceId: string
  readonly createdBy: string
  readonly title: string
  /** SQL 表达式，例如 now() - interval '1 hour'；默认 now() */
  readonly updatedAt?: string
  /** 快照的 unitId：默认新生成；复制文档时与原件相同（00 号计划书 §8.3） */
  readonly unitId?: string
}

export interface SeededDocument {
  readonly id: string
  readonly unitId: string
}

export async function createDocument(database: TestDatabase, options: DocumentOptions): Promise<string> {
  return (await seedDocument(database, options)).id
}

/** 建一份文档并返回它的 unitId：保存的用例要用 unitId 构造快照。 */
export async function seedDocument(database: TestDatabase, options: DocumentOptions): Promise<SeededDocument> {
  const unitId = options.unitId ?? randomUUID()
  const raw = Buffer.from(sheetSnapshotFor(unitId), 'utf8')
  const snapshot = zlib.gzipSync(raw)
  const digest = createHash('sha256').update(`created\nsheet\n${options.title}`, 'utf8').digest()
  return database.query(async (client) => {
    const result = await client.query<{ id: string }>(
      `WITH document AS (
         INSERT INTO documents (space_id, type, title, created_by, updated_at, unit_id, profile, format_version, sdk_version)
         VALUES ($1, 'sheet', $2, $3, ${options.updatedAt ?? 'now()'}, $4, $5, $6, $7) RETURNING id
       ), content AS (
         INSERT INTO document_contents (document_id, snapshot, raw_bytes, stored_bytes) SELECT id, $8, $9, $10 FROM document
       ), revision AS (
         INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, saved_by) SELECT id, 1, 'created', $11, $12, $3 FROM document
       )
       SELECT id FROM document`,
      [options.spaceId, options.title, options.createdBy, unitId, DOCUMENT_PROFILE_OF.sheet, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION, snapshot, raw.length, snapshot.length, randomUUID(), digest],
    )
    const id = result.rows[0]?.id
    if (id === undefined)
      throw new Error('建文档没有返回 id')
    return { id, unitId }
  })
}
