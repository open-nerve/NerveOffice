import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { DocumentAccessPolicy, EffectiveAccessPolicy } from './document-access-policy.ts'
import { DocumentContentController } from './document-content.controller.ts'
import { DocumentContentService } from './document-content.service.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentCreationService } from './document-creation.service.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentsController } from './documents.controller.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { DocumentsService } from './documents.service.ts'
import { LeaselessWriteAccessRevocation, WriteAccessRevocation } from './write-access.ts'

@Module({
  imports: [DatabaseModule, SpacesModule, AuditModule],
  controllers: [DocumentsController, DocumentContentController],
  providers: [
    DocumentsRepository,
    DocumentContentsRepository,
    DocumentRevisionsRepository,
    DocumentsService,
    DocumentCreationService,
    DocumentContentService,
    // 有效权限的唯一入口（M2-P2 设计 §3.4）；P5 在同一个实现里并上单独授权
    { provide: DocumentAccessPolicy, useClass: EffectiveAccessPolicy },
    // 收回写入权的入口（M2-P2 设计 §3.7）；M3 换成接入租约的实现，调用方不改
    { provide: WriteAccessRevocation, useClass: LeaselessWriteAccessRevocation },
  ],
  // 空间的接口（workspace）与系统管理（admin）经访问策略授权、经这个入口收回写入权
  exports: [DocumentAccessPolicy, WriteAccessRevocation],
})
export class DocumentsModule {}
