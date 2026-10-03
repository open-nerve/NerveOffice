// 测试数据：直接写库建单独授权（M2-P5）。分享的接口另有用例；有效权限、"可访问文档"、生效时机与权限矩阵的用例
// 需要一开始就摆好的授权，用它。写出的行与分享的接口写出的一样：新建时两个时间取数据库的当前时间，调整时更新角色、
// 最后设置它的人与 updated_at。
import type { GrantRole } from '@nerve-office/contracts'
import type { TestDatabase } from './database.ts'

export interface GrantOptions {
  readonly documentId: string
  readonly userId: string
  readonly role: GrantRole
  /** 最后设置它的人（分享的人）：不能是被授权人自己（表上的 CHECK） */
  readonly grantedBy: string
}

/** 新建或调整一条授权（一个人在一份文档上至多一条） */
export async function setGrant(database: TestDatabase, options: GrantOptions): Promise<void> {
  await setGrants(database, [options])
}

/**
 * 一次新建或调整几条授权：一个连接、一条语句（权限矩阵给每一份新建的文档都摆上两个只凭授权的人的授权，逐条各开一个连接太慢）。
 * 同一条语句里同一个人在同一份文档上只能出现一次（ON CONFLICT 不能在一条语句里改同一行两次）
 */
export async function setGrants(database: TestDatabase, grants: readonly GrantOptions[]): Promise<void> {
  if (grants.length === 0)
    return
  const values = grants.map((_grant, index) => `($${index * 4 + 1}::uuid, $${index * 4 + 2}::uuid, $${index * 4 + 3}, $${index * 4 + 4}::uuid)`)
  await database.query(async client => client.query(
    `INSERT INTO document_grants (document_id, user_id, role, granted_by) VALUES ${values.join(', ')}
     ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, updated_at = now()`,
    grants.flatMap(grant => [grant.documentId, grant.userId, grant.role, grant.grantedBy]),
  ))
}

/** 取消一条授权（删行，与分享的接口相同） */
export async function removeGrant(database: TestDatabase, documentId: string, userId: string): Promise<void> {
  await database.query(async client => client.query('DELETE FROM document_grants WHERE document_id = $1 AND user_id = $2', [documentId, userId]))
}

/** 这些文档上的授权（按文档、被授权人排序），核对级联删除与"复制不带授权" */
export async function grantsOn(database: TestDatabase, documentIds: readonly string[]): Promise<{ readonly documentId: string, readonly userId: string, readonly role: GrantRole }[]> {
  return database.query(async client => (await client.query<{ documentId: string, userId: string, role: GrantRole }>(
    'SELECT document_id AS "documentId", user_id AS "userId", role FROM document_grants WHERE document_id = ANY($1::uuid[]) ORDER BY document_id, user_id',
    [documentIds],
  )).rows)
}
