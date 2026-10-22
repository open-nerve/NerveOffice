import type { Transaction } from '../database/index.ts'
import type { Actor } from './document-access-policy.ts'
import { Injectable } from '@nestjs/common'
import { documentPermissionsOf } from './access-rules.ts'
import { DocumentAccessPolicy, MISSING_DOCUMENT } from './document-access-policy.ts'
import { DocumentCheckpointClock } from './document-checkpoint-clock.ts'
import { DocumentsRepository } from './documents.repository.ts'

/** 图片的当前引用授权：复用文档的可见范围与权限策略，所有查询属于调用方的同一个只读快照。 */
@Injectable()
export class DocumentAssetAccessService {
  constructor(
    private readonly policy: DocumentAccessPolicy,
    private readonly documents: DocumentsRepository,
    private readonly clock: DocumentCheckpointClock,
  ) {}

  async canRead(actor: Actor, assetId: string, transaction: Transaction): Promise<boolean> {
    const spaces = await this.policy.visibleSpaces(actor, transaction)
    const document = await this.documents.firstAccessibleAssetSource({ spaceIds: spaces.map(({ space }) => space.id), grantsOf: actor.userId }, assetId, transaction)
    // 无可见来源也执行完整权限查询；不按图片存在与否或隐藏引用数量提前返回。
    const access = await this.policy.accessOf(actor.userId, document ?? MISSING_DOCUMENT, transaction)
    const scope = await this.policy.historyScope(actor, transaction)
    const [historical] = await this.documents.historyAssetSources(scope, [assetId], await this.clock.now(transaction), transaction)
    const historyAccess = await this.policy.accessOf(actor.userId, historical ?? MISSING_DOCUMENT, transaction)
    const historyAllowed = historical !== undefined && historyAccess !== undefined && documentPermissionsOf(historyAccess, historical, actor.userId).canViewHistory
    return (document !== undefined && access !== undefined) || historyAllowed
  }
}
