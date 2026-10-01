import type { OneTimeLinkPurpose } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { AttemptTicket } from './attempt-throttle.ts'
import type { LinkRejection } from './link-state.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { AppLogger } from '../logging/index.ts'
import { settleQuietly, tooManyAttempts } from './attempt-errors.ts'
import { LinkThrottle } from './login-throttle.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 一次性链接的尝试（M2-P1 设计 §3.4）：查看、接受邀请、完成重置都先经这里占名额；令牌不能用时记审计。
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
   * 令牌不能用：返回要抛出的错误。
   * - 没有这个令牌、格式不对（invalid）：这才是在试令牌，按地址的名额不退回，计一次失败；记审计；
   *   这次失败使计数达到上限时是 429，否则 LINK_INVALID；
   * - 找到了记录、只是不能用（过期、已用、已作废，或者重置对应的账户已停用）：拿着的是一条真实的旧链接，不是在猜。
   *   按地址的名额退回、不计失败（M2-P6 复核 B3）：否则同一个出口地址（办公室的 NAT）下有人反复打开旧链接，
   *   会把后面拿着有效链接的受邀人、忘了密码的管理员一起挡在门外。退回尽力而为：失败只记日志，这次按一次失败计（与 settleQuietly 一致）。
   *   另按这条记录计数（M2-P6）：没到上限时记审计、LINK_INVALID 与原因；这次使计数达到上限时照样记审计、回 429；
   *   已经锁定时 429、只记日志、不写审计。反复打开同一条旧链接写不爆审计表，也不影响别人与别的链接
   */
  async rejected(ticket: AttemptTicket, purpose: OneTimeLinkPurpose, rejection: LinkRejection, origin: HttpOrigin): Promise<AppError> {
    if (rejection.reason === 'invalid') {
      await this.record(purpose, rejection, origin)
      return ticket.lockedForSeconds === undefined ? linkInvalid(rejection) : tooManyAttempts(ticket.lockedForSeconds)
    }
    await settleQuietly(async () => ticket.abandoned(), this.#logger)
    const admission = await this.throttle.admitRejectedRecord(purpose, rejection.recordId)
    if (!admission.admitted) {
      this.#logger.warn('同一条一次性链接反复被打开，这条链接暂时一律拒绝', { purpose, reason: rejection.reason, lockedForSeconds: admission.retryAfterSeconds })
      return tooManyAttempts(admission.retryAfterSeconds)
    }
    await this.record(purpose, rejection, origin)
    const { lockedForSeconds } = admission.ticket
    return lockedForSeconds === undefined ? linkInvalid(rejection) : tooManyAttempts(lockedForSeconds)
  }

  /** 审计 auth.link_rejected：操作者是未登录的访问者，知道对应的记录时带上对象，details 是用途与原因 */
  private async record(purpose: OneTimeLinkPurpose, rejection: LinkRejection, origin: HttpOrigin): Promise<void> {
    await this.audit.record({
      action: 'auth.link_rejected',
      actor: { type: 'anonymous' },
      ...(rejection.target === undefined ? {} : { target: rejection.target }),
      origin,
      details: { purpose, reason: rejection.reason },
    })
  }
}

function linkInvalid(rejection: LinkRejection): AppError {
  return new AppError('LINK_INVALID', undefined, { details: { reason: rejection.reason } })
}
