import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { Actor, SpaceAccess } from '../documents/index.ts'
import type { SpaceRecord } from '../spaces/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentAccessPolicy, requireSpaceManagement } from '../documents/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { UsersService } from '../users/index.ts'

/** 空间的管理操作（M2-P2 设计 §3.4） */
export type ManagementOperation = 'manageMembers' | 'rename'

/** 锁住的空间与锁下判断出的访问 */
export interface ManagedSpace {
  readonly space: SpaceRecord
  readonly access: SpaceAccess
}

/**
 * 空间的管理操作（成员的添加、调整、移出，改名）在事务里的共同步骤（M2-P2 设计 §3.9）：
 * 复核调用者的系统角色 → 判断（不加锁）→ 锁住空间行 → 锁下再判断。
 * 看不到与不能做的请求不在空间行上取锁（ADR-011 的做法）；锁下再判断，判断之后被移出或降级、空间被归档都能看到。
 */
@Injectable()
export class ManagedSpaces {
  constructor(
    private readonly policy: DocumentAccessPolicy,
    private readonly spaces: SpacesService,
    private readonly users: UsersService,
  ) {}

  /**
   * 事务里的调用者：会话守卫给出的系统角色，在事务第一步取 system-admins 的共享锁复核（复核之后到提交之前不会被取消）。
   * 已经不是系统管理员时按普通成员判断：他可能同时是这个空间的空间管理员
   */
  async actorOf(principal: Principal, transaction: Transaction): Promise<Actor> {
    const systemAdmin = principal.user.systemRole === 'admin' && await this.users.holdSystemAdmin(principal.user.id, transaction)
    return { userId: principal.user.id, systemAdmin }
  }

  /** 判断（不加锁）：看不到是 NOT_FOUND，看得到却不能做是 PERMISSION_DENIED */
  async check(actor: Actor, spaceId: string, operation: ManagementOperation, transaction: Transaction): Promise<void> {
    await requireSpaceManagement(this.policy, actor, spaceId, operation, transaction)
  }

  /** 锁住空间行（FOR NO KEY UPDATE），锁下再判断一次 */
  async lock(actor: Actor, spaceId: string, operation: ManagementOperation, transaction: Transaction): Promise<ManagedSpace> {
    const space = await this.spaces.lockSpace(spaceId, transaction)
    const access = await requireSpaceManagement(this.policy, actor, spaceId, operation, transaction)
    // 空间不删（v0.1），判断通过就一定锁到了行；这里是兜底
    if (space === undefined)
      throw new AppError('NOT_FOUND')
    return { space, access }
  }
}
