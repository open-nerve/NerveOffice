import type { Transaction } from '../database/index.ts'
import type { Actor } from './document-access-policy.ts'
import { Injectable } from '@nestjs/common'
import { DocumentAccessPolicy, MISSING_DOCUMENT } from './document-access-policy.ts'
import { DocumentsRepository } from './documents.repository.ts'

/** 图片的当前引用授权：复用文档的可见范围与权限策略，所有查询属于调用方的同一个只读快照。 */
@Injectable()
export class DocumentAssetAccessService {
  constructor(
    private readonly policy: DocumentAccessPolicy,
    private readonly documents: DocumentsRepository,
  ) {}

  async canRead(actor: Actor, assetId: string, transaction: Transaction): Promise<boolean> {
    const spaces = await this.policy.visibleSpaces(actor, transaction)
    const document = await this.documents.firstAccessibleAssetSource({ spaceIds: spaces.map(({ space }) => space.id), grantsOf: actor.userId }, assetId, transaction)
    // 无可见来源也执行完整权限查询；不按图片存在与否或隐藏引用数量提前返回。
    const access = await this.policy.accessOf(actor.userId, document ?? MISSING_DOCUMENT, transaction)
    return document !== undefined && access !== undefined
  }
}
