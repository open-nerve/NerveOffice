export {
  accessActorOf,
  DocumentAccessPolicy,
  requireSpaceContent,
  requireSpaceManagement,
} from './document-access-policy.ts'
export type { Actor, SpaceAccess, SpaceContentAccess } from './document-access-policy.ts'
export { DocumentTransferService } from './document-transfer.service.ts'
export { DocumentsModule } from './documents.module.ts'
export { FoldersService } from './folders.service.ts'
export type { CreateFolderCommand, MoveFolderCommand, UpdateFolderCommand } from './folders.service.ts'
export { TrashService } from './trash.service.ts'
export type { PurgeOutcome, TrashEntrySummary, TrashPage } from './trash.service.ts'
export { WriteAccessRevocation } from './write-access.ts'
export type { WriteAccessScope } from './write-access.ts'
