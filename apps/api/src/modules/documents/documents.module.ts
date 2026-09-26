import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { DocumentAccessPolicy, PersonalSpaceAccessPolicy } from './document-access-policy.ts'
import { DocumentContentController } from './document-content.controller.ts'
import { DocumentContentService } from './document-content.service.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentCreationService } from './document-creation.service.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentsController } from './documents.controller.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { DocumentsService } from './documents.service.ts'

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
    // M2 换成完整的有效权限，其他代码不改
    { provide: DocumentAccessPolicy, useClass: PersonalSpaceAccessPolicy },
  ],
})
export class DocumentsModule {}
