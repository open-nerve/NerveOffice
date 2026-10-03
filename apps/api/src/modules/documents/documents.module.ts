import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { DocumentAccessPolicy, EffectiveAccessPolicy } from './document-access-policy.ts'
import { DocumentContentController } from './document-content.controller.ts'
import { DocumentContentService } from './document-content.service.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentCopyService } from './document-copy.service.ts'
import { DocumentCreationService } from './document-creation.service.ts'
import { DocumentGrantsRepository } from './document-grants.repository.ts'
import { DocumentGrantsService } from './document-grants.service.ts'
import { DocumentOrganizingService } from './document-organizing.service.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentSearchService } from './document-search.service.ts'
import { DocumentTransferService } from './document-transfer.service.ts'
import { DocumentsController } from './documents.controller.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { DocumentsService } from './documents.service.ts'
import { FoldersRepository } from './folders.repository.ts'
import { FoldersService } from './folders.service.ts'
import { SharedDocumentsService } from './shared-documents.service.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'
import { TrashEntriesRepository } from './trash-entries.repository.ts'
import { TrashEntryPurger } from './trash-entry-purger.ts'
import { TrashPurgeService } from './trash-purge.service.ts'
import { TrashService } from './trash.service.ts'
import { LeaselessWriteAccessRevocation, WriteAccessRevocation } from './write-access.ts'

@Module({
  imports: [DatabaseModule, SpacesModule, AuditModule],
  controllers: [DocumentsController, DocumentContentController],
  providers: [
    DocumentsRepository,
    DocumentContentsRepository,
    DocumentRevisionsRepository,
    FoldersRepository,
    TrashEntriesRepository,
    SpaceTreeRepository,
    // 单独授权（M2-P5）：只在本模块里用（有效权限读它），不在 exports 里、不经公开入口转出
    DocumentGrantsRepository,
    DocumentsService,
    DocumentCreationService,
    DocumentContentService,
    DocumentOrganizingService,
    DocumentCopyService,
    DocumentSearchService,
    DocumentTransferService,
    // 分享（M2-P5）：单独授权的判断、锁下复核与写入（写入的编排在 workspace），"与我共享"
    DocumentGrantsService,
    SharedDocumentsService,
    FoldersService,
    TrashService,
    TrashPurgeService,
    // 永久删除一个删除单元的本体（不判断权限）：只给本模块的 TrashService 与 TrashPurgeService 用，不在 exports 里
    TrashEntryPurger,
    // 有效权限的唯一入口（M2-P2 设计 §3.4）；M2-P5 在同一个实现里并上单独授权
    { provide: DocumentAccessPolicy, useClass: EffectiveAccessPolicy },
    // 收回写入权的入口（M2-P2 设计 §3.7）；M3 换成接入租约的实现，调用方不改
    { provide: WriteAccessRevocation, useClass: LeaselessWriteAccessRevocation },
  ],
  // 空间的接口（workspace）与系统管理（admin）经访问策略授权、经这个入口收回写入权；admin 转移停用者的文档；
  // 文件夹、回收站与搜索的接口在 workspace（M2-P4 设计 §3.1），数据与规则在这里；
  // 分享的接口与写入的编排、"与我共享"在 workspace（要锁被授权人的账户行、补人名，M2-P5 设计 §3.1），授权的规则与数据在这里；
  // 到期的自动清理只给 jobs（M2-P4 设计 §3.1）
  exports: [
    DocumentAccessPolicy,
    WriteAccessRevocation,
    DocumentSearchService,
    DocumentTransferService,
    DocumentGrantsService,
    SharedDocumentsService,
    FoldersService,
    TrashService,
    TrashPurgeService,
  ],
})
export class DocumentsModule {}
