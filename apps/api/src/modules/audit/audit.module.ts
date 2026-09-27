import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/index.ts'
import { AuditProtectionCheck } from './audit-protection-check.ts'
import { AuditRepository } from './audit.repository.ts'
import { AuditService } from './audit.service.ts'

@Module({
  imports: [DatabaseModule],
  providers: [AuditRepository, AuditService, AuditProtectionCheck],
  exports: [AuditService],
})
export class AuditModule {}
