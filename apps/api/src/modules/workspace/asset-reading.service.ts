import type { AssetImage } from '../assets/index.ts'
import type { Actor } from '../documents/index.ts'
import { assetIdSchema } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AssetReadService, AssetStorageError } from '../assets/index.ts'
import { databaseBusyReasonOf, TransactionRunner } from '../database/index.ts'
import { DocumentAssetAccessService } from '../documents/index.ts'
import { AppLogger } from '../logging/index.ts'
import { ASSET_PLACEHOLDER } from './asset-placeholder.ts'

export interface AssetReadResult extends AssetImage {
  readonly status: 200 | 404 | 500 | 503
}

const MISSING_ID = '00000000-0000-0000-0000-000000000000'
function placeholder(status: 404 | 500 | 503): AssetReadResult {
  return { status, data: ASSET_PLACEHOLDER, mimeType: 'image/png' }
}

/** 只编排公开服务：同一快照决定权限，归还连接后才读私有文件。 */
@Injectable()
export class AssetReadingService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly assets: AssetReadService,
    private readonly references: DocumentAssetAccessService,
    private readonly logger: AppLogger,
  ) {}

  async read(actor: Actor, assetId: string): Promise<AssetReadResult> {
    const parsed = assetIdSchema.safeParse(assetId)
    const valid = parsed.success && parsed.data === assetId
    const target = valid ? assetId : MISSING_ID
    let stage: 'metadata' | 'file' = 'metadata'
    try {
      const metadata = await this.transactions.readSnapshot(async (transaction) => {
        const image = await this.assets.metadata(target, transaction)
        const referenced = await this.references.canRead(actor, target, transaction)
        return valid && image !== undefined && ((image.uploaderId === actor.userId && image.withinUploadWindow) || referenced) ? image : undefined
      })
      if (metadata === undefined)
        return placeholder(404)
      stage = 'file'
      return { status: 200, ...await this.assets.readAuthorized(metadata) }
    }
    catch (error) {
      // 快照开场复核的身份错误仍走原认证响应，不吞成图片占位。
      if (error instanceof AppError && (error.status === 401 || error.status === 403))
        throw error
      const busy = databaseBusyReasonOf(error)
      if (busy !== undefined) {
        this.logger.warn('图片读取遇到数据库繁忙', { code: 'ASSET_READ_BUSY', stage, reason: busy })
        return placeholder(503)
      }
      this.logger.error('图片读取失败', { code: 'ASSET_READ_FAILED', stage, reason: error instanceof AssetStorageError ? error.reason : 'unexpected' })
      return placeholder(500)
    }
  }
}
