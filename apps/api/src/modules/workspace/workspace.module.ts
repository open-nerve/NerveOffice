import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { DocumentsModule } from '../documents/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { UsersModule } from '../users/index.ts'
import { DocumentEditingController } from './document-editing.controller.ts'
import { DocumentEditingService } from './document-editing.service.ts'
import { DocumentGrantsController } from './document-grants.controller.ts'
import { DocumentSharingService } from './document-sharing.service.ts'
import { FoldersController } from './folders.controller.ts'
import { ManagedSpaces } from './managed-space.ts'
import { SearchDirectoryService } from './search-directory.service.ts'
import { SearchController } from './search.controller.ts'
import { SharedDirectoryService } from './shared-directory.service.ts'
import { SharedController } from './shared.controller.ts'
import { SpaceDirectoryService } from './space-directory.service.ts'
import { SpaceMembersController } from './space-members.controller.ts'
import { SpaceMembershipService } from './space-membership.service.ts'
import { SpacesController } from './spaces.controller.ts'
import { TrashDirectoryService } from './trash-directory.service.ts'
import { TrashController } from './trash.controller.ts'

/**
 * 面向成员的空间接口与编排（M2-P2 设计 §3.1）：我能看到的空间、空间页头、成员、改名；
 * 文件夹、回收站与搜索（M2-P4 设计 §3.1：接口在这里，规则与数据在 documents）；
 * 分享与"与我共享"（M2-P5 设计 §3.1：写入的编排与接口在这里——要锁被授权人的账户行、补人名；规则与数据在 documents）；
 * 编辑权（M3-P1 设计 §3.1：申请、心跳、释放与编辑状态的接口在这里——响应要补持有者的人名；租约的规则与数据在 documents）。
 * 没有自己的表：授权经 documents 的访问策略，数据经 spaces 与 documents，名字与账户状态经 users，
 * 收回写入权经 documents 的入口。spaces 在依赖链的底层（users、auth、documents 都依赖它），这些接口放不进 spaces。
 */
@Module({
  imports: [DatabaseModule, AuditModule, UsersModule, SpacesModule, DocumentsModule],
  controllers: [SpacesController, SpaceMembersController, FoldersController, TrashController, SearchController, DocumentGrantsController, SharedController, DocumentEditingController],
  providers: [ManagedSpaces, SpaceDirectoryService, SpaceMembershipService, TrashDirectoryService, SearchDirectoryService, DocumentSharingService, SharedDirectoryService, DocumentEditingService],
})
export class WorkspaceModule {}
