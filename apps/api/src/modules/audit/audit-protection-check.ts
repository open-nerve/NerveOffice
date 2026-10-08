import type { OnApplicationBootstrap } from '@nestjs/common'
import type { StartupCheckOutcome } from '../../shared/startup-check.ts'
import type { AuditTableAccess } from './audit.repository.ts'
import { Injectable } from '@nestjs/common'
import { runStartupCheck, STARTUP_CHECK_WAIT_MS } from '../../shared/startup-check.ts'
import { AppLogger } from '../logging/index.ts'
import { AuditRepository } from './audit.repository.ts'

export const AUDIT_BYPASS_WARNING = '连接数据库的角色关得掉审计表的触发器，审计记录只追加的保护可以被绕过：生产环境请用只有读写权限的应用角色（见部署说明）'

/** 关得掉审计表的触发器（ALTER TABLE … DISABLE TRIGGER 需要所有者的权限）：超级用户，或者是表的所有者（及其成员） */
export function canBypassAppendOnly(access: AuditTableAccess): boolean {
  return access.superuser || access.ownsTable === true
}

/** 启动时等检查结果的时限：与就绪检查相同，数据库连不上时不能把开始监听拖到连接超时（审查 A4；启动自检共用的时限） */
export const PROTECTION_CHECK_WAIT_MS = STARTUP_CHECK_WAIT_MS

/**
 * 启动时检查数据库角色（P5 设计 §3.3，审查 A21）：只追加的保护靠触发器，能关掉触发器的角色就能改审计记录。
 * 只记日志，不影响启动：开发库与本机的测试用的是超级用户，照常告警；查询失败（例如数据库不可达）时跳过，就绪探针另有报告。
 * 启动最多等 2 秒；超过时照常启动，查询有了结果再记（启动自检共同的做法，shared/startup-check.ts）。
 */
@Injectable()
export class AuditProtectionCheck implements OnApplicationBootstrap {
  readonly #logger: AppLogger

  constructor(private readonly repository: AuditRepository, logger: AppLogger) {
    this.#logger = logger.with({ module: 'audit' })
  }

  async onApplicationBootstrap(): Promise<void> {
    await runStartupCheck({
      run: async () => this.repository.currentAccess(),
      report: outcome => this.#report(outcome),
      slow: () => this.#logger.warn(`检查数据库角色对审计表的权限超过 ${PROTECTION_CHECK_WAIT_MS} 毫秒，先照常启动，有了结果再记`),
    })
  }

  #report(outcome: StartupCheckOutcome<AuditTableAccess>): void {
    if ('error' in outcome) {
      this.#logger.warn('没能检查数据库角色对审计表的权限，跳过', { err: outcome.error })
      return
    }
    const access = outcome.value
    const fields = { role: access.role, superuser: access.superuser, ownsAuditTable: access.ownsTable }
    if (canBypassAppendOnly(access))
      this.#logger.warn(AUDIT_BYPASS_WARNING, fields)
    else if (access.ownsTable === undefined)
      this.#logger.warn('审计表还不存在（还没有迁移），没有检查数据库角色是不是它的所有者', fields)
    else
      this.#logger.info('数据库角色关不掉审计表的触发器', fields)
  }
}
