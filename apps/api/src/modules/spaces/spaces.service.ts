import type { AdminSpaceListQuery, SpaceRole, SpaceStatus } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { MemberRoleChange, SpaceChange, SpaceFacts, SpaceMemberRecord, SpaceRecord, SpaceSummary, TeamSpaceOverview } from './space.ts'
import { ADMIN_PAGE_SIZE, SPACE_NAME_MAX_LENGTH } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { SpacesRepository } from './spaces.repository.ts'

export interface CreateOptions {
  /** 与创建账户放在同一个事务里（TransactionRunner） */
  transaction?: Transaction
}

export interface QueryOptions {
  /** 在调用方的事务里查询：事务已经占着一个连接，不再从连接池另取一个（连接池耗尽时互相等待） */
  transaction?: Transaction
}

/** 新的团队空间：名称、创建人（系统管理员）、是否全员可见、首个空间管理员 */
export interface NewTeamSpace {
  readonly name: string
  readonly createdBy: string
  readonly visibleToAll: boolean
  readonly adminUserId: string
}

/** 只有团队空间有成员、能改名、全员可见与归档：调用方已经按访问策略或管理接口排除了个人空间，这里是兜底 */
function requireTeam(space: SpaceRecord): void {
  if (space.type !== 'team')
    throw new Error(`不是团队空间：${space.id}`)
}

/**
 * 空间（M1-P3 设计 §3.6；M2-P2 设计 §3.1）：个人空间与团队空间、成员与空间角色的数据与不变量。
 * 只提供事实与变更，不判断谁能做什么：授权由调用方经 documents 的访问策略或管理接口决定。
 * 改动空间与成员的方法要求调用方先用 lockSpace 锁住空间行，传入锁下读到的空间。
 */
@Injectable()
export class SpacesService {
  constructor(private readonly repository: SpacesRepository) {}

  /** 新建个人空间：名称取所有者的显示名（界面上显示为"我的空间"）。 */
  async createPersonalSpace(ownerUserId: string, ownerDisplayName: string, options: CreateOptions = {}): Promise<SpaceSummary> {
    const name = [...ownerDisplayName].slice(0, SPACE_NAME_MAX_LENGTH).join('')
    return this.repository.insertPersonal(ownerUserId, name, options.transaction)
  }

  /**
   * 建团队空间，连同首个空间管理员（M2-P2 设计 §3.9）。名称按判重键（看起来一样的名称算同一个名字，M2-P6 复核 B 的 M-1；
   * 已归档的也算）已被使用时 SPACE_NAME_TAKEN
   */
  async createTeamSpace(team: NewTeamSpace, transaction: Transaction): Promise<SpaceRecord> {
    const space = await this.repository.insertTeam({ name: team.name, createdBy: team.createdBy, visibleToAll: team.visibleToAll }, transaction)
    if (space === 'name_taken')
      throw new AppError('SPACE_NAME_TAKEN')
    await this.repository.insertMember(space.id, team.adminUserId, 'admin', transaction)
    return space
  }

  /** 这个人的个人空间；账户创建时一并创建，正常情况下一定存在。 */
  async personalSpaceOf(userId: string, options: QueryOptions = {}): Promise<SpaceSummary | undefined> {
    return this.repository.findPersonalByOwner(userId, options.transaction)
  }

  /** 这个人看某个空间的事实；空间不存在时为 undefined（查询与存在时相同）。 */
  async accessFactsOf(userId: string, spaceId: string, options: QueryOptions = {}): Promise<SpaceFacts | undefined> {
    return this.repository.factsFor(userId, spaceId, options.transaction)
  }

  /** 这个人可能看得到的空间（候选）：个人空间在前，团队空间按名称排序。 */
  async visibleSpacesOf(userId: string): Promise<SpaceFacts[]> {
    return this.repository.visibleCandidatesFor(userId)
  }

  /** 以共享锁持住空间行再读：在空间里新建文档、转移的来源与目标（M2-P2 设计 §3.6、§3.8）；不存在时为 undefined */
  async holdSpace(spaceId: string, transaction: Transaction): Promise<SpaceRecord | undefined> {
    return this.repository.lockShared(spaceId, transaction)
  }

  /** 锁住空间行（FOR NO KEY UPDATE）再读：改动空间与成员的事务先锁它（锁的顺序见 M2-P2 设计 §3.9） */
  async lockSpace(spaceId: string, transaction: Transaction): Promise<SpaceRecord | undefined> {
    return this.repository.lockRecord(spaceId, transaction)
  }

  /** 改名：名称没有变化时原样返回；已被使用时 SPACE_NAME_TAKEN */
  async rename(space: SpaceRecord, name: string, transaction: Transaction): Promise<SpaceChange> {
    requireTeam(space)
    if (space.name === name)
      return { space, changed: false }
    const renamed = await this.repository.rename(space.id, name, transaction)
    if (renamed === 'name_taken')
      throw new AppError('SPACE_NAME_TAKEN')
    return { space: renamed, changed: true }
  }

  async setVisibility(space: SpaceRecord, visibleToAll: boolean, transaction: Transaction): Promise<SpaceChange> {
    requireTeam(space)
    if (space.visibleToAll === visibleToAll)
      return { space, changed: false }
    return { space: await this.repository.update(space.id, { visibleToAll }, transaction), changed: true }
  }

  /** 归档（archived）与恢复（active） */
  async setStatus(space: SpaceRecord, status: SpaceStatus, transaction: Transaction): Promise<SpaceChange> {
    requireTeam(space)
    if (space.status === status)
      return { space, changed: false }
    return { space: await this.repository.update(space.id, { status }, transaction), changed: true }
  }

  async members(spaceId: string): Promise<SpaceMemberRecord[]> {
    return this.repository.listMembers(spaceId)
  }

  /** 加成员：已经是成员时 ALREADY_MEMBER（改角色用 changeMemberRole） */
  async addMember(space: SpaceRecord, userId: string, role: SpaceRole, transaction: Transaction): Promise<SpaceMemberRecord> {
    requireTeam(space)
    const member = await this.repository.insertMember(space.id, userId, role, transaction)
    if (member === undefined)
      throw new AppError('ALREADY_MEMBER')
    return member
  }

  /** 调整角色：不是成员时 NOT_FOUND；会让空间一个空间管理员都不剩时 LAST_SPACE_ADMIN */
  async changeMemberRole(space: SpaceRecord, userId: string, role: SpaceRole, transaction: Transaction): Promise<MemberRoleChange> {
    const member = await this.requireMember(space, userId, transaction)
    if (member.role === role)
      return { member, previousRole: role, changed: false }
    if (member.role === 'admin')
      await this.requireAnotherAdmin(space, transaction)
    return { member: await this.repository.updateMemberRole(space.id, userId, role, transaction), previousRole: member.role, changed: true }
  }

  /** 移出：返回移出之前的成员；不是成员时 NOT_FOUND；移出最后一个空间管理员时 LAST_SPACE_ADMIN */
  async removeMember(space: SpaceRecord, userId: string, transaction: Transaction): Promise<SpaceMemberRecord> {
    const member = await this.requireMember(space, userId, transaction)
    if (member.role === 'admin')
      await this.requireAnotherAdmin(space, transaction)
    await this.repository.deleteMember(space.id, userId, transaction)
    return member
  }

  /** 管理界面的团队空间列表：按创建时间从新到旧分页，带成员数与查看者自己的角色 */
  async listTeamSpaces(viewerId: string, query: AdminSpaceListQuery): Promise<{ readonly items: TeamSpaceOverview[], readonly nextCursor: string | null }> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    // 多取一条，判断还有没有下一页
    const rows = await this.repository.listTeamOverviews(viewerId, { query: query.query, status: query.status, after, limit: ADMIN_PAGE_SIZE + 1 })
    const items = rows.slice(0, ADMIN_PAGE_SIZE)
    const last = items.at(-1)
    return { items, nextCursor: rows.length > ADMIN_PAGE_SIZE && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null }
  }

  /** 管理界面里的一个团队空间（变更之后的响应）；不是团队空间时为 undefined */
  async teamSpaceOverview(viewerId: string, spaceId: string, transaction: Transaction): Promise<TeamSpaceOverview | undefined> {
    const [row] = await this.repository.listTeamOverviews(viewerId, { spaceId, limit: 1 }, transaction)
    return row
  }

  /** 按 id 批量取空间的名称：审计查询补名字 */
  async namesOf(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const found = await this.repository.findNames([...new Set(ids)])
    return new Map(found.map(space => [space.id, space.name]))
  }

  private async requireMember(space: SpaceRecord, userId: string, transaction: Transaction): Promise<SpaceMemberRecord> {
    requireTeam(space)
    const member = await this.repository.findMember(space.id, userId, transaction)
    if (member === undefined)
      throw new AppError('NOT_FOUND', '这个人不是空间的成员')
    return member
  }

  /** 要降级或移出一个空间管理员：除了他还得有别的空间管理员（在空间行的锁下数，两个人同时互相降级只有一个成功） */
  private async requireAnotherAdmin(space: SpaceRecord, transaction: Transaction): Promise<void> {
    if (await this.repository.countAdmins(space.id, transaction) <= 1)
      throw new AppError('LAST_SPACE_ADMIN')
  }
}
