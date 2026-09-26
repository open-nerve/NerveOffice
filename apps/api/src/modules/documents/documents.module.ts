import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { DocumentAccessPolicy, PersonalSpaceAccessPolicy } from './document-access-policy.ts'
import { DocumentsController } from './documents.controller.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { DocumentsService } from './documents.service.ts'

@Module({
  imports: [DatabaseModule, SpacesModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsRepository,
    DocumentsService,
    // M2 换成完整的有效权限，其他代码不改
    { provide: DocumentAccessPolicy, useClass: PersonalSpaceAccessPolicy },
  ],
})
export class DocumentsModule {}
