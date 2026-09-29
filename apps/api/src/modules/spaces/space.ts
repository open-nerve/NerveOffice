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
