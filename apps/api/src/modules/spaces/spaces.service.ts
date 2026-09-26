import type { Transaction } from '../database/index.ts'
import type { SpaceSummary } from './space.ts'
import { SPACE_NAME_MAX_LENGTH } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { SpacesRepository } from './spaces.repository.ts'

export interface CreateOptions {
  /** 与创建账户放在同一个事务里（TransactionRunner） */
  transaction?: Transaction
}

/** 空间（P3 设计 §3.6）：M1 只有个人空间，每人一个，只有所有者可见。 */
@Injectable()
export class SpacesService {
  constructor(private readonly repository: SpacesRepository) {}

  /** 新建个人空间：名称取所有者的显示名（界面上显示为"我的空间"）。 */
  async createPersonalSpace(ownerUserId: string, ownerDisplayName: string, options: CreateOptions = {}): Promise<SpaceSummary> {
    const name = [...ownerDisplayName].slice(0, SPACE_NAME_MAX_LENGTH).join('')
    return this.repository.insertPersonal(ownerUserId, name, options.transaction)
  }

  /** 这个人的个人空间；账户创建时一并创建，正常情况下一定存在。 */
  async personalSpaceOf(userId: string): Promise<SpaceSummary | undefined> {
    return this.repository.findPersonalByOwner(userId)
  }

  async isOwner(userId: string, spaceId: string): Promise<boolean> {
    return this.repository.isOwner(userId, spaceId)
  }
}
