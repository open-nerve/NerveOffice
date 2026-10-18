import type { Transaction } from '../database/index.ts'
import type { AssetReferenceMetadata } from './asset-metadata.ts'
import { Injectable } from '@nestjs/common'
import { AssetsRepository } from './assets.repository.ts'

@Injectable()
export class AssetReferenceService {
  constructor(private readonly repository: AssetsRepository) {}

  /** 预选用，不授予引用权；调用方必须在空间/文档锁后用 hold 重新确认。 */
  async inspect(ids: readonly string[], transaction: Transaction): Promise<readonly AssetReferenceMetadata[]> {
    return this.repository.referenceMetadata(ids, false, transaction)
  }

  /** 全部空间、既有文档锁之后，按 assetId 顺序取得共享锁；不取配额或对象锁。 */
  async hold(ids: readonly string[], transaction: Transaction): Promise<readonly AssetReferenceMetadata[]> {
    return this.repository.referenceMetadata(ids, true, transaction)
  }
}
