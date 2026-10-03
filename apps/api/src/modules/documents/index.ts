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
export { FoldersService } from './folders.service.ts'
export type { CreateFolderCommand, MoveFolderCommand, UpdateFolderCommand } from './folders.service.ts'
export { SharedDocumentsService } from './shared-documents.service.ts'
export type { SharedPage } from './shared-documents.service.ts'
export type { PurgeOutcome } from './trash-entry-purger.ts'
export { TrashPurgeService } from './trash-purge.service.ts'
export type { ExpiredPurgeResult, ExpiredTrashEntry } from './trash-purge.service.ts'
export { TrashService } from './trash.service.ts'
export type { TrashEntrySummary, TrashPage } from './trash.service.ts'
export { WriteAccessRevocation } from './write-access.ts'
export type { WriteAccessScope } from './write-access.ts'
