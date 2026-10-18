import type { Transaction } from '../database/index.ts'
import type { AssetImage, AssetMetadata } from './asset-metadata.ts'
import type { StorageAdapter } from './storage-adapter.ts'
import { Inject, Injectable } from '@nestjs/common'
import { AssetsRepository } from './assets.repository.ts'
import { ASSET_STORAGE, assetObjectKey } from './storage-adapter.ts'

/** Assets 只提供元数据与文件；业务授权由 Workspace 组合文档域，避免反向依赖。 */
@Injectable()
export class AssetReadService {
  constructor(private readonly repository: AssetsRepository, @Inject(ASSET_STORAGE) private readonly storage: StorageAdapter) {}

  async metadata(assetId: string, transaction: Transaction): Promise<AssetMetadata | undefined> {
    return this.repository.metadata(assetId, transaction)
  }

  /** 调用方必须先完成授权并退出数据库只读快照，再读取文件。 */
  async readAuthorized(metadata: AssetMetadata): Promise<AssetImage> {
    const data = await this.storage.read(assetObjectKey(metadata.sha256), metadata)
    return { data, mimeType: metadata.mimeType }
  }
}
