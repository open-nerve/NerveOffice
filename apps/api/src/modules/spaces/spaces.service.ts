import type { Transaction } from '../database/index.ts'
import type { SpaceFacts, SpaceSummary } from './space.ts'
import { SPACE_NAME_MAX_LENGTH } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { SpacesRepository } from './spaces.repository.ts'

export interface CreateOptions {
  /** 与创建账户放在同一个事务里（TransactionRunner） */
  transaction?: Transaction
}

export interface QueryOptions {
  /** 在调用方的事务里查询：事务已经占着一个连接，不再从连接池另取一个（连接池耗尽时互相等待） */
  transaction?: Transaction
}

/**
 * 空间（M1-P3 设计 §3.6；M2-P2 设计 §3.1）：个人空间与团队空间、成员与空间角色的数据与不变量。
 * 只提供事实与变更，不判断谁能做什么：授权由调用方经 documents 的访问策略决定。
 */
@Injectable()
export class SpacesService {
  constructor(private readonly repository: SpacesRepository) {}

  /** 新建个人空间：名称取所有者的显示名（界面上显示为"我的空间"）。 */
  async createPersonalSpace(ownerUserId: string, ownerDisplayName: string, options: CreateOptions = {}): Promise<SpaceSummary> {
    const name = [...ownerDisplayName].slice(0, SPACE_NAME_MAX_LENGTH).join('')
    return this.repository.insertPersonal(ownerUserId, name, options.transaction)
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

  /** 对空间行取共享锁：在空间里新建文档、作为转移的目标（M2-P2 设计 §3.6、§3.8） */
  async lockShared(spaceId: string, transaction: Transaction): Promise<void> {
    await this.repository.lockShared(spaceId, transaction)
  }
}
