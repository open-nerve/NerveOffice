export {
  accessActorOf,
  DocumentAccessPolicy,
  requireSpaceContent,
  requireSpaceManagement,
} from './document-access-policy.ts'
export type { Actor, SpaceAccess, SpaceContentAccess } from './document-access-policy.ts'
export { DocumentSearchService } from './document-search.service.ts'
export { DocumentTransferService } from './document-transfer.service.ts'
export { DocumentsModule } from './documents.module.ts'
// 只为 app 层的程序接口转出（集成测试直接核对仓储的查询范围）：别的模块引用它由 eslint 拦下（M2-P6 复核 A 的 S3）
export { DocumentsRepository } from './documents.repository.ts'
export { FoldersService } from './folders.service.ts'
export type { CreateFolderCommand, MoveFolderCommand, UpdateFolderCommand } from './folders.service.ts'
export type { PurgeOutcome } from './trash-entry-purger.ts'
export { TrashPurgeService } from './trash-purge.service.ts'
export type { ExpiredPurgeResult, ExpiredTrashEntry } from './trash-purge.service.ts'
export { TrashService } from './trash.service.ts'
export type { TrashEntrySummary, TrashPage } from './trash.service.ts'
export { WriteAccessRevocation } from './write-access.ts'
export type { WriteAccessScope } from './write-access.ts'
