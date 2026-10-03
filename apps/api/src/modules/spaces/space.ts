import type { SpaceRole, SpaceStatus, SpaceType } from '@nerve-office/contracts'

/** 空间的摘要：接口与其他模块只需要 id 与名称。 */
export interface SpaceSummary {
  readonly id: string
  readonly name: string
}

/**
 * 计算权限用的空间事实（M2-P2 设计 §3.4）：空间行与这个人的成员行，一条语句取出。
 * 这里只有事实，不判断谁能做什么：有效权限由 documents 的访问策略计算。
 */
export interface SpaceFacts {
  readonly id: string
  readonly type: SpaceType
  readonly name: string
  readonly status: SpaceStatus
  readonly visibleToAll: boolean
  /** 这个人是不是它的所有者（只有个人空间有所有者） */
  readonly owned: boolean
  /** 这个人在这个空间里的成员角色；不是成员时为空 */
  readonly memberRole: SpaceRole | null
}

/**
 * 一批空间的事实（M2-P5："与我共享"与搜索按一批 id 取所在的空间）：SpaceFacts 之外带上所有者的账户 id——
 * 个人空间按所有者的人名呈现（存的名称是所有者建号时的显示名，可以伪造，规范 §2.4），人名由调用方经 users 补上
 */
export interface SpaceFactsWithOwner extends SpaceFacts {
  /** 个人空间的所有者；团队空间为空 */
  readonly ownerUserId: string | null
}

/** 空间的一行（管理用：改名、全员可见、归档与恢复、成员）。 */
export interface SpaceRecord {
  readonly id: string
  readonly type: SpaceType
  readonly name: string
  readonly status: SpaceStatus
  readonly visibleToAll: boolean
  readonly createdAt: Date
}

/** 空间的变更结果：没有变化（例如归档已归档的空间）时 changed 为假，调用方不记审计。 */
export interface SpaceChange {
  readonly space: SpaceRecord
  readonly changed: boolean
}

/** 团队空间的一个成员（只有账户 id：名字由调用方经 users 补上）。 */
export interface SpaceMemberRecord {
  readonly userId: string
  readonly role: SpaceRole
  readonly createdAt: Date
}

/** 成员角色的变更：原来的角色与变更之后的成员；角色相同时 changed 为假。 */
export interface MemberRoleChange {
  readonly member: SpaceMemberRecord
  readonly previousRole: SpaceRole
  readonly changed: boolean
}

/** 管理界面里的团队空间：成员数（含停用的成员），以及查看的系统管理员自己在里面的角色。 */
export interface TeamSpaceOverview extends SpaceRecord {
  readonly memberCount: number
  readonly myRole: SpaceRole | null
  /** 游标用的创建时间：数据库算出的 UTC 文本，保留微秒 */
  readonly position: string
}
