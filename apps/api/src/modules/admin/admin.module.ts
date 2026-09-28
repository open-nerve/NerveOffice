import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { AuthModule } from '../auth/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { UsersModule } from '../users/index.ts'
import { AdminAuditController } from './admin-audit.controller.ts'
import { AdminAuditService } from './admin-audit.service.ts'
import { AdminInvitationsController } from './admin-invitations.controller.ts'
import { AdminUsersController } from './admin-users.controller.ts'
import { AdminUsersService } from './admin-users.service.ts'

/**
 * 系统管理（M2-P1 设计 §3.1）：只有接口与跨模块的编排，没有自己的表。
 * 全部接口只给系统管理员（@SystemAdminOnly()，由会话守卫检查）。
 */
@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, UsersModule],
  controllers: [AdminUsersController, AdminInvitationsController, AdminAuditController],
  providers: [AdminUsersService, AdminAuditService],
})
export class AdminModule {}
