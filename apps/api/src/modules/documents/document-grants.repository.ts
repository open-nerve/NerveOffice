import type { GrantRole } from '@nerve-office/contracts'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import { documentGrants } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

const g = documentGrants

/**
 * "这个人在这份文档上有单独授权"：与外层语句里的文档行关联的 EXISTS 条件（documentId 是外层的文档 id 列）。
 * "可访问文档"的授权那一半用它（documents.repository.ts 的 accessible，那里是条件的唯一一处）：
 * document_grants 上的 SQL 都写在这个文件里，documents 的仓储不直接碰这张表。走主键 (document_id, user_id)
 */
export function grantedTo(documentId: AnyPgColumn, userId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${g} WHERE ${and(eq(g.documentId, documentId), eq(g.userId, userId))})`
}

/**
 * 单独授权（M2-P5 设计 §3.3）：只有它读写 document_grants（一表一仓储，规范 §1.2）。
 * 只在 documents 模块里用：有效权限（DocumentAccessPolicy）经它读一个人在一份文档上的授权；不从模块的公开入口转出（lint 拦下）。
 * 永久删除文档时授权随外键级联删除，这里没有对应的方法
 */
@Injectable()
export class DocumentGrantsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * 这个人在这份文档上的授权角色，没有授权时为 undefined。一条按主键的语句：
   * 文档不存在时访问策略用全零的 id 照样执行这一条，只是没有结果行（看不到与不存在执行同样的语句，M2-P5 设计 §3.1）。
   * 不看文档的状态：回收站里的文档在读到授权之前就已经按不存在处理（仓储的 findById 只取正常状态的行）
   */
  async roleOf(documentId: string, userId: string, transaction?: Transaction): Promise<GrantRole | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .select({ role: g.role })
      .from(g)
      .where(and(eq(g.documentId, documentId), eq(g.userId, userId)))
    return row?.role
  }
}
