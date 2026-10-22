import type { AppConfig } from '../config/index.ts'
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { AuthModule } from '../auth/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { HealthModule } from '../health/index.ts'
import { AssetGcClock, DatabaseAssetGcClock } from './asset-gc-clock.ts'
import { AssetGcRepository } from './asset-gc.repository.ts'
import { AssetGcService } from './asset-gc.service.ts'
import { AssetQuotaRepository } from './asset-quota.repository.ts'
import { AssetReadService } from './asset-read.service.ts'
import { AssetReferenceService } from './asset-reference.service.ts'
import { AssetRetirementRepository } from './asset-retirement.repository.ts'
import { AssetRetirementService } from './asset-retirement.service.ts'
import { AssetUploadService } from './asset-upload.service.ts'
import { AssetUploadInterceptor } from './asset-upload.ts'
import { AssetsRepository } from './assets.repository.ts'
import { FileStorage } from './file-storage.ts'
import { ImageRunner } from './image-runner.ts'
import { ASSET_STORAGE } from './storage-adapter.ts'
import { AssetTemporaryFiles } from './temporary-files.ts'

@Module({
  imports: [AuthModule, DatabaseModule, HealthModule, AuditModule],
  providers: [
    AssetsRepository,
    AssetQuotaRepository,
    AssetGcRepository,
    AssetGcService,
    AssetRetirementRepository,
    AssetRetirementService,
    { provide: AssetGcClock, useClass: DatabaseAssetGcClock },
    AssetReadService,
    AssetReferenceService,
    AssetUploadService,
    AssetUploadInterceptor,
    AssetTemporaryFiles,
    { provide: ImageRunner, useFactory: () => new ImageRunner() },
    {
      provide: ASSET_STORAGE,
      inject: [APP_CONFIG, AssetTemporaryFiles],
      useFactory: (config: AppConfig, temporary: AssetTemporaryFiles) => {
        if (config.assets.root === undefined)
          throw new Error('服务端缺少私有资源目录')
        return new FileStorage(config.assets.root, temporary)
      },
    },
  ],
  exports: [AssetUploadService, AssetUploadInterceptor, AssetReadService, AssetReferenceService, AssetGcService, AssetRetirementService],
})
export class AssetsModule {}
