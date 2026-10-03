import type { SpaceRole, SpaceStatus } from '@nerve-office/contracts'
import type { SQL } from 'drizzle-orm'
import type { TimeCursor } from '../../shared/time-cursor.ts'
import type { Database, Transaction } from '../database/index.ts'
import type { SpaceFacts, SpaceFactsWithOwner, SpaceMemberRecord, SpaceRecord, SpaceSummary, TeamSpaceOverview } from './space.ts'
import { collapseNameBlanks } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { spaceMembers, spaceNameForSearch, spaces } from '../../db/schema/spaces/index.ts'
import { containsPattern } from '../../shared/like-pattern.ts'
import { DATABASE, executorOf, inIdArray, inSavepoint, isUniqueViolation, keysetPosition } from '../database/index.ts'

/** 团队空间名称的唯一索引：撞上它就是名称已被使用 */
const TEAM_NAME_KEY = 'spaces_team_name_key'

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

const RECORD_COLUMNS = {
  id: spaces.id,
  type: spaces.type,
  name: spaces.name,
  status: spaces.status,
  visibleToAll: spaces.visibleToAll,
  createdAt: spaces.createdAt,
}

const MEMBER_COLUMNS = {
  userId: spaceMembers.userId,
  role: spaceMembers.role,
  createdAt: spaceMembers.createdAt,
}

/** 管理界面的团队空间列表的筛选与分页 */
export interface TeamSpaceFilter {
  readonly query?: string | undefined
  readonly status?: SpaceStatus | undefined
  readonly spaceId?: string
  readonly after?: TimeCursor | undefined
  readonly limit: number
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

  /**
   * 建团队空间；名称按判重键（name_key：看起来一样的名称算同一个名字，M2-P6 复核 B 的 M-1）已被使用时返回 name_taken
   * （由判重键上的唯一索引兜住并发的创建与改名）
   */
  async insertTeam(team: { readonly name: string, readonly createdBy: string, readonly visibleToAll: boolean }, transaction: Transaction): Promise<SpaceRecord | 'name_taken'> {
    try {
      return await inSavepoint(transaction, async (executor) => {
        const [row] = await executor.insert(spaces).values({ type: 'team', ...team }).returning(RECORD_COLUMNS)
        if (row === undefined)
          throw new Error('新建团队空间没有返回记录')
        return row
      })
    }
    catch (error) {
      if (isUniqueViolation(error, TEAM_NAME_KEY))
        return 'name_taken'
      throw error
    }
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
   * 一个人看一批空间的事实，连同所有者（M2-P5）：一条语句，这串 id 作为一个数组参数（inIdArray，数量没有上界时也不会超出
   * 绑定参数的上限，规范 §5）；不存在的空间没有结果行。与 factsFor 同样左连接这个人的成员行，事实的算法只有 factColumns 一处
   */
  async factsForMany(userId: string, spaceIds: readonly string[], transaction?: Transaction): Promise<SpaceFactsWithOwner[]> {
    if (spaceIds.length === 0)
      return []
    return executorOf(this.db, transaction)
      .select({ ...factColumns(userId), ownerUserId: spaces.ownerUserId })
      .from(spaces)
      .leftJoin(spaceMembers, and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, userId)))
      .where(inIdArray(spaces.id, spaceIds))
  }

  /**
   * 一个人可能看得到的空间：他的个人空间、他是成员的团队空间、全员可见的团队空间。
   * 只是候选：看不看得到、是什么角色，由访问策略按事实计算。个人空间在前，团队空间按名称（不区分大小写）排序。
   */
  async visibleCandidatesFor(userId: string, transaction?: Transaction): Promise<SpaceFacts[]> {
    return executorOf(this.db, transaction)
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
   * 以共享锁读空间行（FOR SHARE）：在空间里新建文档、转移的来源与目标用。
   * 与改动空间与成员（FOR NO KEY UPDATE）互斥：归档、移出成员提交之后，锁下再判断就能看到（M2-P2 设计 §3.6、§3.8）。
   */
  async lockShared(spaceId: string, transaction: Transaction): Promise<SpaceRecord | undefined> {
    const [row] = await executorOf(this.db, transaction).select(RECORD_COLUMNS).from(spaces).where(eq(spaces.id, spaceId)).for('share')
    return row
  }

  /**
   * 锁住空间行再读（FOR NO KEY UPDATE）：改名、全员可见、归档与恢复、成员的变更都先锁它，
   * 成员的变更因此在同一个空间里逐个执行（"至少保留一个空间管理员"），也与在空间里新建（FOR SHARE）互斥。
   * 不用 FOR UPDATE：它与外键检查取的 FOR KEY SHARE 冲突，在空间里新建文档、添加成员都要等它
   */
  async lockRecord(spaceId: string, transaction: Transaction): Promise<SpaceRecord | undefined> {
    const [row] = await executorOf(this.db, transaction).select(RECORD_COLUMNS).from(spaces).where(eq(spaces.id, spaceId)).for('no key update')
    return row
  }

  /** 改名；名称已被使用时返回 name_taken（见 insertTeam） */
  async rename(spaceId: string, name: string, transaction: Transaction): Promise<SpaceRecord | 'name_taken'> {
    try {
      return await inSavepoint(transaction, async (executor) => {
        const [row] = await executor.update(spaces).set({ name, updatedAt: sql`now()` }).where(eq(spaces.id, spaceId)).returning(RECORD_COLUMNS)
        if (row === undefined)
          throw new Error(`改名时空间不在了：${spaceId}`)
        return row
      })
    }
    catch (error) {
      if (isUniqueViolation(error, TEAM_NAME_KEY))
        return 'name_taken'
      throw error
    }
  }

  async update(spaceId: string, changes: { readonly status?: SpaceStatus, readonly visibleToAll?: boolean }, transaction: Transaction): Promise<SpaceRecord> {
    const [row] = await executorOf(this.db, transaction).update(spaces).set({ ...changes, updatedAt: sql`now()` }).where(eq(spaces.id, spaceId)).returning(RECORD_COLUMNS)
    if (row === undefined)
      throw new Error(`更新空间时空间不在了：${spaceId}`)
    return row
  }

  /** 管理界面的团队空间：成员数与查看者自己的角色；按创建时间从新到旧（keyset） */
  async listTeamOverviews(viewerId: string, filter: TeamSpaceFilter, transaction?: Transaction): Promise<TeamSpaceOverview[]> {
    const mine = alias(spaceMembers, 'mine')
    const conditions: (SQL | undefined)[] = [
      eq(spaces.type, 'team'),
      filter.spaceId === undefined ? undefined : eq(spaces.id, filter.spaceId),
      // 空白的种类与个数不算区别（M2-P6 复验 G1）：名称与关键词两边的每一段空白都合成一个普通空格再比较
      filter.query === undefined || filter.query === '' ? undefined : ilike(spaceNameForSearch, containsPattern(collapseNameBlanks(filter.query))),
      filter.status === undefined ? undefined : eq(spaces.status, filter.status),
      filter.after === undefined ? undefined : sql`(${spaces.createdAt}, ${spaces.id}) < (${filter.after.position}::timestamptz, ${filter.after.id}::uuid)`,
    ]
    return executorOf(this.db, transaction)
      .select({ ...RECORD_COLUMNS, position: keysetPosition(spaces.createdAt), memberCount: count(spaceMembers.userId), myRole: mine.role })
      .from(spaces)
      .leftJoin(spaceMembers, eq(spaceMembers.spaceId, spaces.id))
      .leftJoin(mine, and(eq(mine.spaceId, spaces.id), eq(mine.userId, viewerId)))
      .where(and(...conditions))
      .groupBy(spaces.id, mine.role)
      .orderBy(desc(spaces.createdAt), desc(spaces.id))
      .limit(filter.limit)
  }

  /** 按 id 批量取空间的名称（含个人空间）：审计查询补名字用 */
  async findNames(ids: readonly string[], transaction?: Transaction): Promise<SpaceSummary[]> {
    if (ids.length === 0)
      return []
    return executorOf(this.db, transaction).select({ id: spaces.id, name: spaces.name }).from(spaces).where(inArray(spaces.id, [...ids]))
  }

  async listMembers(spaceId: string, transaction?: Transaction): Promise<SpaceMemberRecord[]> {
    return executorOf(this.db, transaction).select(MEMBER_COLUMNS).from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId))
  }

  async findMember(spaceId: string, userId: string, transaction: Transaction): Promise<SpaceMemberRecord | undefined> {
    const [row] = await executorOf(this.db, transaction).select(MEMBER_COLUMNS).from(spaceMembers).where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    return row
  }

  /** 加成员；已经是成员时返回 undefined（主键冲突时什么也不做） */
  async insertMember(spaceId: string, userId: string, role: SpaceRole, transaction: Transaction): Promise<SpaceMemberRecord | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .insert(spaceMembers)
      .values({ spaceId, userId, role })
      .onConflictDoNothing({ target: [spaceMembers.spaceId, spaceMembers.userId] })
      .returning(MEMBER_COLUMNS)
    return row
  }

  async updateMemberRole(spaceId: string, userId: string, role: SpaceRole, transaction: Transaction): Promise<SpaceMemberRecord> {
    const [row] = await executorOf(this.db, transaction)
      .update(spaceMembers)
      .set({ role, updatedAt: sql`now()` })
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
      .returning(MEMBER_COLUMNS)
    if (row === undefined)
      throw new Error(`调整角色时成员不在了：${spaceId} ${userId}`)
    return row
  }

  async deleteMember(spaceId: string, userId: string, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).delete(spaceMembers).where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
  }

  /** 这个空间的空间管理员数（成员行，不看账户状态） */
  async countAdmins(spaceId: string, transaction: Transaction): Promise<number> {
    const [row] = await executorOf(this.db, transaction)
      .select({ admins: count() })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, 'admin')))
    return row?.admins ?? 0
  }
}
