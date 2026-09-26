// 测试数据：直接写库建文档（本 Phase 没有新建文档的接口，P4 加上）。
import type { TestDatabase } from './database.ts'

export interface DocumentOptions {
  readonly spaceId: string
  readonly createdBy: string
  readonly title: string
  /** SQL 表达式，例如 now() - interval '1 hour'；默认 now() */
  readonly updatedAt?: string
}

export async function createDocument(database: TestDatabase, options: DocumentOptions): Promise<string> {
  return database.query(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO documents (space_id, type, title, created_by, updated_at) VALUES ($1, 'sheet', $2, $3, ${options.updatedAt ?? 'now()'}) RETURNING id`,
      [options.spaceId, options.title, options.createdBy],
    )
    const id = result.rows[0]?.id
    if (id === undefined)
      throw new Error('建文档没有返回 id')
    return id
  })
}
