import type { AssetRetentionProbe } from '../assets/index.ts'
import type { Transaction } from '../database/index.ts'
import { Injectable } from '@nestjs/common'
import { DocumentAssetsRepository } from './document-assets.repository.ts'
import { DocumentHistoryRepository } from './document-history.repository.ts'

/** 保留资格包含不可读/回收站/运维/到期未清材料；不接受用户身份，不赋予读取权限。 */
@Injectable()
export class DocumentAssetRetentionService implements AssetRetentionProbe {
  constructor(private readonly current: DocumentAssetsRepository, private readonly history: DocumentHistoryRepository) {}

  async retained(ids: readonly string[], transaction: Transaction): Promise<ReadonlySet<string>> {
    const current = await this.current.retainedAssetIds(ids, transaction)
    const history = await this.history.retainedAssetIds(ids, transaction)
    return new Set([...current, ...history])
  }
}
