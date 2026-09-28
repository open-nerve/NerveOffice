import type { LinkInvalidReason, OneTimeLinkPurpose } from '@nerve-office/contracts'
import type { AuditEvent, AuditOrigin } from '../audit/index.ts'
import type { AttemptTicket } from './attempt-throttle.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { AppLogger } from '../logging/index.ts'
import { tooManyAttempts } from './attempt-errors.ts'
import { LinkThrottle } from './login-throttle.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 一次性链接的尝试（M2-P1 设计 §3.4）：查看、接受邀请、完成重置都先经这里占名额；令牌不能用时记审计、按一次失败计。
 * 锁定期间只记日志，不写审计：攻击时不能把审计表写爆。
 */
@Injectable()
export class LinkAttempts {
  readonly #logger: AppLogger

  constructor(
    private readonly throttle: LinkThrottle,
    private readonly audit: AuditService,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'auth' })
  }

  /** 占名额；锁定中时 429（只记日志） */
  async admit(origin: HttpOrigin): Promise<AttemptTicket> {
    const admission = await this.throttle.admit(origin.clientIp)
    if (!admission.admitted) {
      this.#logger.warn('一次性链接的尝试被限流拒绝', { lockedForSeconds: admission.retryAfterSeconds })
      throw tooManyAttempts(admission.retryAfterSeconds)
    }
    return admission.ticket
  }

  /**
   * 令牌不能用：记审计（知道对应的记录时带上对象），名额不退回（按一次失败计），返回要抛出的错误：
   * 这次失败使计数达到上限时是 429，否则是 LINK_INVALID 与原因
   */
  async rejected(ticket: AttemptTicket, purpose: OneTimeLinkPurpose, reason: LinkInvalidReason, target: AuditEvent['target'], origin: HttpOrigin): Promise<AppError> {
    await this.audit.record({
      action: 'auth.link_rejected',
      actor: { type: 'anonymous' },
      ...(target === undefined ? {} : { target }),
      origin,
      details: { purpose, reason },
    })
    return ticket.lockedForSeconds === undefined
      ? new AppError('LINK_INVALID', undefined, { details: { reason } })
      : tooManyAttempts(ticket.lockedForSeconds)
  }
}
