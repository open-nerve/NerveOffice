import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { DatabaseDocumentCheckpointClock, DocumentCheckpointClock } from './document-checkpoint-clock.ts'
import { DocumentCheckpointService } from './document-checkpoint.service.ts'
import { DocumentCheckpointsRepository } from './document-checkpoints.repository.ts'
import { DocumentUpgradeRepository } from './document-upgrade.repository.ts'
import { DocumentUpgradeService } from './document-upgrade.service.ts'

/** 仅 CLI 的窄组合：不导入 DocumentsModule、HTTP、Jobs、Assets 或图片/快照子进程池。 */
@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [DocumentUpgradeRepository, DocumentUpgradeService, DocumentCheckpointService, DocumentCheckpointsRepository, { provide: DocumentCheckpointClock, useClass: DatabaseDocumentCheckpointClock }],
  exports: [DocumentUpgradeService],
})
export class DocumentsOperationsModule {}
