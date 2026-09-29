import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { DocumentsModule } from '../documents/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { UsersModule } from '../users/index.ts'
import { ManagedSpaces } from './managed-space.ts'
import { SpaceDirectoryService } from './space-directory.service.ts'
import { SpaceMembersController } from './space-members.controller.ts'
import { SpaceMembershipService } from './space-membership.service.ts'
import { SpacesController } from './spaces.controller.ts'

/**
 * 面向成员的空间接口与编排（M2-P2 设计 §3.1）：我能看到的空间、空间页头、成员、改名。没有自己的表：
 * 授权经 documents 的访问策略，数据经 spaces，名字与账户状态经 users，收回写入权经 documents 的入口。
 * spaces 在依赖链的底层（users、auth、documents 都依赖它），这些接口放不进 spaces。
 */
@Module({
  imports: [DatabaseModule, AuditModule, UsersModule, SpacesModule, DocumentsModule],
  controllers: [SpacesController, SpaceMembersController],
  providers: [ManagedSpaces, SpaceDirectoryService, SpaceMembershipService],
})
export class WorkspaceModule {}
