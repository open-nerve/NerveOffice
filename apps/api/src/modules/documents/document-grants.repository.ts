import type { GrantRole } from '@nerve-office/contracts'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, sql } from 'drizzle-orm'
import { documentGrants } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

const g = documentGrants

/** 一条单独授权（M2-P5 设计 §3.3）：被授权人、角色、最后设置这个角色的人与时间（数据库时间） */
export interface GrantRow {
  readonly documentId: string
  readonly userId: string
  readonly role: GrantRole
  /** 最后设置这个角色的人（新建或调整） */
  readonly grantedBy: string
  readonly createdAt: Date
  /** 最后设置这个角色的时间 */
  readonly updatedAt: Date
}

/** 新建一条授权要写的列：两个时间取数据库的当前时间（列的默认值） */
export interface NewGrant {
  readonly documentId: string
  readonly userId: string
  readonly role: GrantRole
  readonly grantedBy: string
}

const COLUMNS = {
  documentId: g.documentId,
  userId: g.userId,
  role: g.role,
  grantedBy: g.grantedBy,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
}

/** 这个人在这份文档上的那一条（主键） */
function grantKey(documentId: string, userId: string): SQL | undefined {
  return and(eq(g.documentId, documentId), eq(g.userId, userId))
}

/**
 * "这个人在这份文档上有单独授权"：与外层语句里的文档行关联的 EXISTS 条件（documentId 是外层的文档 id 列）。
 * "可访问文档"的授权那一半用它（documents.repository.ts 的 accessible，那里是条件的唯一一处）；搜索把同一个条件另选成一列，
 * 作为"这一行凭授权命中"的标志（与行出自同一条语句，M2-P5 设计 §3.4(2)）。
 * document_grants 上的 SQL 都写在这个文件里，documents 的仓储不直接碰这张表。走主键 (document_id, user_id)
 */
export function grantedTo(documentId: AnyPgColumn, userId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${g} WHERE ${and(eq(g.documentId, documentId), eq(g.userId, userId))})`
}

/**
 * 这个人在外层语句里那份文档上的授权角色，没有时为 NULL：一个标量子查询（走主键）。
 * "与我共享"按授权那一半列出文档时，把角色与行在同一条语句里一起取出（同一个快照，M2-P5 设计 §3.4(4)）
 */
export function grantRoleOf(documentId: AnyPgColumn, userId: string): SQL<GrantRole | null> {
  return sql<GrantRole | null>`(SELECT ${g.role} FROM ${g} WHERE ${and(eq(g.documentId, documentId), eq(g.userId, userId))})`
}

/**
 * 单独授权（M2-P5 设计 §3.3）：只有它读写 document_grants（一表一仓储，规范 §1.2）。
 * 只在 documents 模块里用：有效权限（DocumentAccessPolicy）经它读一个人在一份文档上的授权，分享的写入（DocumentGrantsService）
 * 经它读写；不从模块的公开入口转出（lint 拦下）。
 * 写入都在调用方锁住的文档行之下（FOR UPDATE）：同一份文档上的授权逐个改动，读到的"现有的授权"到提交之前不会变。
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
      .where(grantKey(documentId, userId))
    return row?.role
  }

  /** 这个人在这份文档上的那一条授权（整行），没有时为 undefined：分享的写入在文档行的锁下读它 */
  async find(documentId: string, userId: string, transaction: Transaction): Promise<GrantRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(g).where(grantKey(documentId, userId))
    return row
  }

  /** 这份文档的全部授权（含停用的人的）：一份文档的授权至多是全部同事，不分页；顺序由调用方按人名排 */
  async listFor(documentId: string): Promise<GrantRow[]> {
    return this.db.select(COLUMNS).from(g).where(eq(g.documentId, documentId)).orderBy(asc(g.userId))
  }

  /** 新建（调用方已锁住文档行、确认还没有这一条）：被授权人不能是设置人，由表上的 CHECK 兜底 */
  async insert(grant: NewGrant, transaction: Transaction): Promise<GrantRow> {
    const [row] = await executorOf(this.db, transaction).insert(g).values(grant).returning(COLUMNS)
    if (row === undefined)
      throw new Error('新建授权没有返回记录')
    return row
  }

  /** 调整角色（调用方已锁住文档行）：一起更新最后设置它的人与时间（数据库时间） */
  async updateRole(documentId: string, userId: string, role: GrantRole, grantedBy: string, transaction: Transaction): Promise<GrantRow> {
    const [row] = await executorOf(this.db, transaction)
      .update(g)
      .set({ role, grantedBy, updatedAt: sql`now()` })
      .where(grantKey(documentId, userId))
      .returning(COLUMNS)
    if (row === undefined)
      throw new Error(`调整授权时授权不在了：${documentId}`)
    return row
  }

  /** 取消（调用方已锁住文档行）：删行，返回删掉的那一条；没有时为 undefined。历史在审计里，不做软删除 */
  async delete(documentId: string, userId: string, transaction: Transaction): Promise<GrantRow | undefined> {
    const [row] = await executorOf(this.db, transaction).delete(g).where(grantKey(documentId, userId)).returning(COLUMNS)
    return row
  }
}
