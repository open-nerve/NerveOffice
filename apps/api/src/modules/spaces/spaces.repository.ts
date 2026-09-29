import type { Database, Transaction } from '../database/index.ts'
import type { SpaceFacts, SpaceSummary } from './space.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm'
import { spaceMembers, spaces } from '../../db/schema/spaces/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

/** 一个人看空间时的事实：空间行左连接这个人的成员行（所有者只看个人空间，成员只看团队空间，由访问策略区分） */
function factColumns(userId: string) {
  return {
    id: spaces.id,
    type: spaces.type,
    name: spaces.name,
    status: spaces.status,
    visibleToAll: spaces.visibleToAll,
    owned: sql<boolean>`coalesce(${spaces.ownerUserId} = ${userId}, false)`,
    memberRole: spaceMembers.role,
  }
}

/** 只有它读写 spaces 与 space_members（规范 §1.2）。 */
@Injectable()
export class SpacesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insertPersonal(ownerUserId: string, name: string, transaction?: Transaction): Promise<SpaceSummary> {
    const [row] = await executorOf(this.db, transaction)
      .insert(spaces)
      .values({ type: 'personal', name, ownerUserId })
      .returning({ id: spaces.id, name: spaces.name })
    if (row === undefined)
      throw new Error('新建个人空间没有返回记录')
    return row
  }

  async findPersonalByOwner(ownerUserId: string, transaction?: Transaction): Promise<SpaceSummary | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .select({ id: spaces.id, name: spaces.name })
      .from(spaces)
      .where(and(eq(spaces.type, 'personal'), eq(spaces.ownerUserId, ownerUserId)))
    return row
  }

  /**
   * 一个人看某个空间的事实：一条语句，空间不存在时同样执行这一条，只是没有结果行
   * （"无权与不存在一致"：两条路径的查询相同，M2-P2 设计 §3.4）。
   */
  async factsFor(userId: string, spaceId: string, transaction?: Transaction): Promise<SpaceFacts | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .select(factColumns(userId))
      .from(spaces)
      .leftJoin(spaceMembers, and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, userId)))
      .where(eq(spaces.id, spaceId))
    return row
  }

  /**
   * 一个人可能看得到的空间：他的个人空间、他是成员的团队空间、全员可见的团队空间。
   * 只是候选：看不看得到、是什么角色，由访问策略按事实计算。个人空间在前，团队空间按名称（不区分大小写）排序。
   */
  async visibleCandidatesFor(userId: string): Promise<SpaceFacts[]> {
    return this.db
      .select(factColumns(userId))
      .from(spaces)
      .leftJoin(spaceMembers, and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, userId)))
      .where(or(
        and(eq(spaces.type, 'personal'), eq(spaces.ownerUserId, userId)),
        and(eq(spaces.type, 'team'), or(eq(spaces.visibleToAll, true), isNotNull(spaceMembers.userId))),
      ))
      .orderBy(sql`${spaces.type} <> 'personal'`, sql`lower(${spaces.name})`, asc(spaces.id))
  }

  /**
   * 对空间行取 FOR SHARE：在空间里新建文档、作为转移的目标时用。
   * 与改动空间与成员（FOR NO KEY UPDATE）互斥：归档、移出成员提交之后，锁下再判断就能看到（M2-P2 设计 §3.6）。
   */
  async lockShared(spaceId: string, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).select({ id: spaces.id }).from(spaces).where(eq(spaces.id, spaceId)).for('share')
  }
}
