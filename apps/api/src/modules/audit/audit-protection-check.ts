import type { OnApplicationBootstrap } from '@nestjs/common'
import type { AuditTableAccess } from './audit.repository.ts'
import { Injectable } from '@nestjs/common'
import { AppLogger } from '../logging/index.ts'
import { AuditRepository } from './audit.repository.ts'

export const AUDIT_BYPASS_WARNING = '连接数据库的角色关得掉审计表的触发器，审计记录只追加的保护可以被绕过：生产环境请用只有读写权限的应用角色（见部署说明）'

/** 关得掉审计表的触发器（ALTER TABLE … DISABLE TRIGGER 需要所有者的权限）：超级用户，或者是表的所有者（及其成员） */
export function canBypassAppendOnly(access: AuditTableAccess): boolean {
  return access.superuser || access.ownsTable === true
}

/**
 * 启动时检查数据库角色（P5 设计 §3.3，审查 A21）：只追加的保护靠触发器，能关掉触发器的角色就能改审计记录。
 * 只记日志，不影响启动：开发库与本机的测试用的是超级用户，照常告警；数据库不可达时跳过（就绪探针另有报告）。
 */
@Injectable()
export class AuditProtectionCheck implements OnApplicationBootstrap {
  readonly #logger: AppLogger

  constructor(private readonly repository: AuditRepository, logger: AppLogger) {
    this.#logger = logger.with({ module: 'audit' })
  }

  async onApplicationBootstrap(): Promise<void> {
    let access: AuditTableAccess
    try {
      access = await this.repository.currentAccess()
    }
    catch (error) {
      this.#logger.warn('没能检查数据库角色对审计表的权限，跳过', { err: error })
      return
    }
    const fields = { role: access.role, superuser: access.superuser, ownsAuditTable: access.ownsTable }
    if (canBypassAppendOnly(access))
      this.#logger.warn(AUDIT_BYPASS_WARNING, fields)
    else if (access.ownsTable === undefined)
      this.#logger.warn('审计表还不存在（还没有迁移），没有检查数据库角色是不是它的所有者', fields)
    else
      this.#logger.info('数据库角色关不掉审计表的触发器', fields)
  }
}
