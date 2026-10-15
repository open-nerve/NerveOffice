import type { SessionExpiredDetails } from '@nerve-office/contracts'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { SessionState } from './sessions.repository.ts'
import { Inject, Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { APP_CONFIG } from '../config/index.ts'
import { generateSessionToken, isWellFormedSessionToken, sessionTokenDigest } from './session-token.ts'
import { SessionsRepository } from './sessions.repository.ts'

/** 只表达这条会话最初的撤销原因；未识别的令牌不带账户事实。 */
function expiredDetailsOf(state: SessionState | undefined): SessionExpiredDetails {
  if (state === undefined)
    return { reason: 'expired' }
  return { reason: state.revokedReason === 'disabled' ? 'account_disabled' : state.revokedReason ?? 'expired', userId: state.userId }
}

export interface CreatedSession {
  readonly id: string
  /** 只交给 Cookie，不写日志、不写库 */
  readonly token: string
}

export interface AuthenticatedSession {
  readonly id: string
  readonly userId: string
  /** 距上次记录活动已超过 1 分钟：keepAlive 时要顺延 */
  readonly stale: boolean
}

/** 服务端会话（P3 设计 §3.5）：令牌在 Cookie 里，库里只有摘要；空闲与绝对过期都用数据库时间判断。 */
@Injectable()
export class SessionService {
  constructor(
    private readonly repository: SessionsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 登录时新建：每次都是新的令牌（防会话固定）。 */
  async create(userId: string, transaction?: Transaction): Promise<CreatedSession> {
    const token = generateSessionToken()
    const { idleTimeoutMinutes, absoluteTimeoutMinutes } = this.config.session
    const { id } = await this.repository.insert({
      userId,
      tokenHash: sessionTokenDigest(token),
      idleMinutes: idleTimeoutMinutes,
      absoluteMinutes: absoluteTimeoutMinutes,
    }, transaction)
    return { id, token }
  }

  /**
   * 每个请求：令牌对应的会话仍然有效时返回它。不在这里顺延：会话守卫确认账户有效之后再 keepAlive，
   * 停用的账户的会话不会一直续着（M2-P1 审查 A1）
   */
  async authenticate(token: string): Promise<AuthenticatedSession | undefined> {
    if (!isWellFormedSessionToken(token))
      return undefined
    return this.repository.findActive(sessionTokenDigest(token))
  }

  /**
   * 租约持有者或请求编辑者的登录是否仍有效；调用方只需要布尔事实时使用。
   * 当前请求的登录复核使用 requireActive，让失效响应同时带出同一行的原因。
   */
  async isActive(sessionId: string, transaction: Transaction): Promise<boolean> {
    return this.repository.isActiveById(sessionId, transaction)
  }

  /**
   * 读快照开场或写事务里再核对这次登录（M3-P1 审查 A1，ADR-017、ADR-018）：会话守卫在处理器之前判断过，之后到这一步还隔着上传正文、等锁、取连接，
   * 这期间退出、签发重置（撤销这个人的全部登录）、停用（同一事务撤销全部登录）、换令牌、别处修改密码都不经调用方锁的行，挡不住在途的请求。
   * 在调用方的事务里按主键查一条：撤销提交之后才做的核对一定看得到它，剩下"核对之后、提交之前"的几毫秒按"请求先于撤销"线性化。
   * 失效时 401 SESSION_EXPIRED，不动 Cookie（与只读快照的开场核对同一个说法），下一个请求经守卫处理。
   * 持有者自己的请求（documents 的申请、心跳、保存、交出、谢绝）与本机密钥的取用（M3-P6 设计 §3.5）共用这一个口径
   */
  async requireActive(sessionId: string, transaction: Transaction): Promise<void> {
    const state = await this.repository.stateById(sessionId, transaction)
    if (state?.active !== true)
      throw new AppError('SESSION_EXPIRED', undefined, { details: expiredDetailsOf(state) })
  }

  /** 已经确认失效的请求在原事务内取详情，退出/改密提交或回滚后不再查库。 */
  async expiredDetails(sessionId: string, transaction: Transaction): Promise<SessionExpiredDetails> {
    return expiredDetailsOf(await this.repository.stateById(sessionId, transaction))
  }

  /** 守卫的失效响应与 Cookie 处理共用同一事实；replaced 不清除浏览器可能已有的新 Cookie。 */
  async expiredDetailsForToken(token: string | undefined, transaction?: Transaction): Promise<SessionExpiredDetails> {
    if (token === undefined || !isWellFormedSessionToken(token))
      return { reason: 'expired' }
    return expiredDetailsOf(await this.repository.stateByTokenHash(sessionTokenDigest(token), transaction))
  }

  /** 距上次记录超过 1 分钟时顺延空闲过期（不超过绝对过期） */
  async keepAlive(session: AuthenticatedSession): Promise<void> {
    if (session.stale)
      await this.repository.touch(session.id, this.config.session.idleTimeoutMinutes)
  }

  /** 撤销一条会话：退出；或者会话守卫发现账户已不可用（disabled）。返回这次撤销了没有（它已经被撤销过时为假） */
  async revoke(sessionId: string, reason: 'logout' | 'disabled', transaction?: Transaction): Promise<boolean> {
    return this.repository.revoke({ id: sessionId }, reason, transaction)
  }

  /**
   * 撤销这个人的全部会话（M2-P1 设计 §3.5）：账户停用、签发与完成重置时全部撤销（修改密码见 revokeForPasswordChange）。
   * 调用方的事务先锁住账户的行（UsersService.lockAccount 等）：登录的事务复核时也锁这一行，
   * 两边一先一后，这里撤销的包括先提交的登录新建的会话（审查 A1）。会话守卫对每个请求另查账户状态。
   */
  async revokeAllOf(
    userId: string,
    reason: 'disabled' | 'password_reset',
    options: { readonly transaction?: Transaction } = {},
  ): Promise<void> {
    await this.repository.revokeAllOfUser(userId, reason, options.transaction)
  }

  /**
   * 修改密码时撤销本人的全部会话（M2-P1 设计 §3.5），调用方随后为当前页面新建一个（M2-P6 复核 B1：换掉令牌，偷到的 Cookie 随之失效）：
   * - 当前这条按 replaced 撤销：它换成了新的，发出修改密码的浏览器随即拿到新的 Cookie。同一个浏览器里（包括别的标签页，
   *   它们用的是同一条会话）换令牌之前发出、之后才处理的请求不清除 Cookie（reason=replaced）；
   * - 其余的按 password_changed 撤销：别的设备上的 Cookie 照常清除（M2-P6 复验 一般-3）。
   * 先当前、后其余：反过来的话，当前这条会被后者一并记成 password_changed。与重新登录"先作废原来的、再新建"同一个顺序，
   * 都在调用方的事务里，账户的行已经锁住（UsersService.replacePassword）；锁的顺序见 ADR-007。
   * 返回当前这条是不是由这次撤销的：为假时它在认证之后、这个事务之前已经结束了（同一个浏览器里刚退出，或者刚重新登录、
   * 换成了新的会话），其余的也不再动，调用方回滚、按"登录已过期"回答（M2-P6）
   */
  async revokeForPasswordChange(userId: string, currentSessionId: string, transaction: Transaction): Promise<boolean> {
    if (!await this.repository.revoke({ id: currentSessionId }, 'replaced', transaction))
      return false
    await this.repository.revokeAllOfUser(userId, 'password_changed', transaction)
    return true
  }

  /** 删除一小批过期或撤销已超过 30 天的会话，表不会无限增长。在事务之外调用。 */
  async purgeExpired(): Promise<void> {
    await this.repository.purgeExpired()
  }

  /** 同一个浏览器重新登录：原来的会话作废（原因 replaced）。令牌不合法或会话已失效时什么都不做。 */
  async replace(token: string, transaction?: Transaction): Promise<void> {
    if (isWellFormedSessionToken(token))
      await this.repository.revoke({ tokenHash: sessionTokenDigest(token) }, 'replaced', transaction)
  }
}
