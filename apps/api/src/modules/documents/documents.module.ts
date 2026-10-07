import type { AppConfig } from '../config/index.ts'
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { AuthModule } from '../auth/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { ClientFormatGate } from './client-format-gate.ts'
import { DocumentAccessPolicy, EffectiveAccessPolicy } from './document-access-policy.ts'
import { DocumentConflictCopyService } from './document-conflict-copy.service.ts'
import { DocumentContentController } from './document-content.controller.ts'
import { DocumentContentService } from './document-content.service.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentCopyService } from './document-copy.service.ts'
import { DocumentCreationService } from './document-creation.service.ts'
import { DocumentGrantsRepository } from './document-grants.repository.ts'
import { DocumentGrantsService } from './document-grants.service.ts'
import { DocumentOrganizingService } from './document-organizing.service.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentSaveReceiptsRepository } from './document-save-receipts.repository.ts'
import { DocumentSearchService } from './document-search.service.ts'
import { DocumentTransferService } from './document-transfer.service.ts'
import { DocumentsController } from './documents.controller.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { DocumentsService } from './documents.service.ts'
import { EditLeaseService } from './edit-lease.service.ts'
import { EditLeasesRepository } from './edit-leases.repository.ts'
import { EditRequestService } from './edit-request.service.ts'
import { FoldersRepository } from './folders.repository.ts'
import { FoldersService } from './folders.service.ts'
import { LeaseWriteAccessRevocation } from './lease-write-access.ts'
import { OpenCheckReportGate } from './open-check-report-gate.ts'
import { OpenCheckReportsController } from './open-check-reports.controller.ts'
import { OpenCheckReportService } from './open-check-reports.service.ts'
import { RequestLedger } from './request-ledger.ts'
import { RevisionPurgeService } from './revision-purge.service.ts'
import { SharedDocumentsService } from './shared-documents.service.ts'
import { SnapshotInspector } from './snapshot-inspector.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'
import { TrashEntriesRepository } from './trash-entries.repository.ts'
import { TrashEntryPurger } from './trash-entry-purger.ts'
import { TrashPurgeService } from './trash-purge.service.ts'
import { TrashService } from './trash.service.ts'
import { WriteAccessRevocation } from './write-access.ts'

@Module({
  // auth 只为判断别人的租约绑定的登录还在不在（SessionService.isActive，M3-P1 设计 §3.1）；auth 不依赖 documents，依赖图无环
  imports: [DatabaseModule, SpacesModule, AuditModule, AuthModule],
  controllers: [DocumentsController, DocumentContentController, OpenCheckReportsController],
  providers: [
    DocumentsRepository,
    DocumentContentsRepository,
    DocumentRevisionsRepository,
    // 保存的回执（M3-P3）：内容相同、修订号没变的确认，只给本模块的保存
    DocumentSaveReceiptsRepository,
    // 写入的 requestId（M3-P3 审查 A3）：requestId 的锁与修订记录、回执两张表里的记录；保存、新建、复制、另存为副本都经它
    RequestLedger,
    FoldersRepository,
    TrashEntriesRepository,
    SpaceTreeRepository,
    // 单独授权（M2-P5）：只在本模块里用（有效权限读它），不在 exports 里、不经公开入口转出
    DocumentGrantsRepository,
    // 编辑租约（M3-P1）：仓储只在本模块里用；申请、心跳、释放与编辑状态的服务给 workspace 的接口编排
    EditLeasesRepository,
    EditLeaseService,
    // 请求编辑与交出（M3-P5）：发出、续期、取消、谢绝与交出的服务，同样给 workspace 的接口编排
    EditRequestService,
    DocumentsService,
    DocumentCreationService,
    DocumentContentService,
    DocumentOrganizingService,
    DocumentCopyService,
    // 另存为副本（M3-P2）：按上传的快照新建，接口与复制同在 DocumentsController
    DocumentConflictCopyService,
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
    // 修订记录与回执的保留期清理（M3-P3 设计 §3.9）：只给 jobs（与 TrashPurgeService 同样由 lint 限定）
    RevisionPurgeService,
    // 有效权限的唯一入口（M2-P2 设计 §3.4）；M2-P5 在同一个实现里并上单独授权
    { provide: DocumentAccessPolicy, useClass: EffectiveAccessPolicy },
    // 收回写入权的入口（M2-P2 设计 §3.7）：M3-P1 起接上编辑租约（结束失去写入权的人的租约、代次加一），调用方不改
    { provide: WriteAccessRevocation, useClass: LeaseWriteAccessRevocation },
    // 拦截旧客户端（M3-P3 设计 §3.5）：按运维开关核对页面上报的构建与数据格式；保存、另存为副本与编辑租约的服务用
    ClientFormatGate,
    // 打开自检失败的上报（M3-P4 设计 §3.13）：能读就能报、记 warn；进程内的去重与按账户限量（每个应用实例一份，单调时钟）
    OpenCheckReportService,
    { provide: OpenCheckReportGate, useFactory: () => new OpenCheckReportGate() },
    // 快照的检查（M3-P3 设计 §3.3）：子进程池，子进程按需创建、空闲到期与退出时结束；只在本模块里用（保存与另存为副本）
    {
      provide: SnapshotInspector,
      inject: [APP_CONFIG, AppLogger],
      useFactory: (config: AppConfig, logger: AppLogger) => new SnapshotInspector(config.snapshotInspection, logger),
    },
  ],
  // 空间的接口（workspace）与系统管理（admin）经访问策略授权、经这个入口收回写入权；admin 转移停用者的文档；
  // 文件夹、回收站与搜索的接口在 workspace（M2-P4 设计 §3.1），数据与规则在这里；
  // 分享的接口与写入的编排、"与我共享"在 workspace（要锁被授权人的账户行、补人名，M2-P5 设计 §3.1），授权的规则与数据在这里；
  // 到期的自动清理与修订记录、回执的保留期清理只给 jobs（M2-P4 设计 §3.1，M3-P3 设计 §3.9）；
  // 编辑权的接口在 workspace（要补持有者的人名，M3-P1 设计 §3.1），租约的规则与数据在这里；请求编辑与交出（M3-P5）同样
  exports: [
    DocumentAccessPolicy,
    EditLeaseService,
    EditRequestService,
    WriteAccessRevocation,
    DocumentSearchService,
    DocumentTransferService,
    DocumentGrantsService,
    SharedDocumentsService,
    FoldersService,
    TrashService,
    TrashPurgeService,
    RevisionPurgeService,
  ],
})
export class DocumentsModule {}
