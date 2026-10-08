import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { AuthModule } from '../auth/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { DocumentsModule } from '../documents/index.ts'
import { LocalKeysModule } from '../local-keys/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { UsersModule } from '../users/index.ts'
import { AdminAuditController } from './admin-audit.controller.ts'
import { AdminAuditService } from './admin-audit.service.ts'
import { AdminInvitationsController } from './admin-invitations.controller.ts'
import { AdminSpacesController } from './admin-spaces.controller.ts'
import { AdminSpacesService } from './admin-spaces.service.ts'
import { AdminTransferService } from './admin-transfer.service.ts'
import { AdminUserDocumentsController } from './admin-user-documents.controller.ts'
import { AdminUsersController } from './admin-users.controller.ts'
import { AdminUsersService } from './admin-users.service.ts'

/**
 * 系统管理（M2-P1 设计 §3.1，M2-P2 设计 §3.1）：只有接口与跨模块的编排，没有自己的表。
 * 全部接口只给系统管理员（@SystemAdminOnly()，由会话守卫检查）。
 */
@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, UsersModule, SpacesModule, DocumentsModule, LocalKeysModule],
  controllers: [AdminUsersController, AdminUserDocumentsController, AdminInvitationsController, AdminSpacesController, AdminAuditController],
  providers: [AdminUsersService, AdminTransferService, AdminSpacesService, AdminAuditService],
})
export class AdminModule {}
