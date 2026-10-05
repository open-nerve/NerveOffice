export {
  accessActorOf,
  DocumentAccessPolicy,
  requireSpaceContent,
  requireSpaceManagement,
} from './document-access-policy.ts'
export type { Actor, SpaceAccess, SpaceContentAccess } from './document-access-policy.ts'
// 只为集成测试专用的入口（app/integration.test-support.ts）转出：读正文的回归用例在判断完权限、读正文之前停住
// （M2 Codex 评审 CX1，permissions/read-snapshot.test.ts）。别的文件经这里引用它由 eslint 拦下
export { DocumentContentsRepository } from './document-contents.repository.ts'
export { DocumentGrantsService } from './document-grants.service.ts'
export type { DocumentGrantRecord, GrantChange, SharingTarget } from './document-grants.service.ts'
export { DocumentSearchService } from './document-search.service.ts'
export type { SearchPage } from './document-search.service.ts'
export { DocumentTransferService } from './document-transfer.service.ts'
export type { LocatedSpace, SearchHit, SharedHit } from './document-views.ts'
export { DocumentsModule } from './documents.module.ts'
// 只为集成测试专用的入口（app/integration.test-support.ts）转出，集成测试直接核对仓储的查询范围：
// 别的文件经这里引用它由 eslint 拦下（M2-P6 复核 A 的 S3、复验 R-S4）
export { DocumentsRepository } from './documents.repository.ts'
// 编辑租约（M3-P1）：编辑权的接口在 workspace，令牌的参数装饰器也给 S4 的保存用
export { EditLeaseToken } from './edit-lease-header.ts'
export type { LeaseInterruption } from './edit-lease-rules.ts'
export { editingActorOf, EditLeaseService } from './edit-lease.service.ts'
export type { EditingActor, LeaseAcquisition, LeaseRequest, LeaseStatus, RenewalRequest } from './edit-lease.service.ts'
export { FoldersService } from './folders.service.ts'
export type { CreateFolderCommand, MoveFolderCommand, UpdateFolderCommand } from './folders.service.ts'
// 修订记录与回执的保留期清理（M3-P3 设计 §3.9）：只给 jobs，别处经这里引用由 eslint 拦下
export { RevisionPurgeService } from './revision-purge.service.ts'
export type { PurgedRecords } from './revision-purge.service.ts'
export { SharedDocumentsService } from './shared-documents.service.ts'
export type { SharedPage } from './shared-documents.service.ts'
export type { PurgeOutcome } from './trash-entry-purger.ts'
export { TrashPurgeService } from './trash-purge.service.ts'
export type { ExpiredPurgeResult, ExpiredTrashEntry } from './trash-purge.service.ts'
export { TrashService } from './trash.service.ts'
export type { TrashEntrySummary, TrashPage } from './trash.service.ts'
export { WriteAccessRevocation } from './write-access.ts'
export type { WriteAccessScope } from './write-access.ts'
