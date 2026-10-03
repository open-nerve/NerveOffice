import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { generateSessionToken, isWellFormedSessionToken, sessionTokenDigest } from './session-token.ts'
import { SessionsRepository } from './sessions.repository.ts'

/**
 * 换令牌时撤销的原因（复验 N3）：只有 replaced——同一个浏览器重新登录、修改密码时，这个浏览器原来的会话换成了新的，
 * 它随即拿到新的 Cookie，还带着旧 Cookie 的是换令牌之前就发出的请求。
 * 修改密码时本人的其余会话（别的设备上的）按 password_changed 撤销：那些设备不会有新的 Cookie，照常清除，
 * 免得它们在 Cookie 到期之前每次打开都提示"登录已过期"、每个请求多查一次库（M2-P6 复验 一般-3）
 */
const ROTATION_REASONS = ['replaced'] as const

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
   * 守卫认证过的这条会话现在仍然有效（没有撤销、没有过期）：只读快照的开场核对在快照里问（M2 Codex 评审复验的建议 3），
   * 守卫之后到快照开始之间撤销的会话（退出、签发重置撤销全部会话、换令牌）在快照里看得到
   */
  async isActive(sessionId: string, transaction: Transaction): Promise<boolean> {
    return this.repository.isActiveById(sessionId, transaction)
  }

  /**
   * 这条令牌是不是因为换令牌（ROTATION_REASONS）而失效的（复验 N3）。会话守卫在会话无效时问它：是的话仍回"登录已过期"，
   * 但不清除 Cookie——换令牌之前发出、之后才处理的请求，响应晚于新 Cookie 到达时，清除会把新的删掉，本人随即掉线。
   * 退出、过期、停用、重置密码、修改密码时别的设备上的会话等其他原因照旧清除。令牌格式不对时不查库。
   * 退出时在退出的事务里问（传入事务）：提交之后不再访问数据库（M2-P6 第 3 片复验）
   */
  async invalidatedByRotation(token: string, transaction?: Transaction): Promise<boolean> {
    if (!isWellFormedSessionToken(token))
      return false
    return this.repository.revokedFor(sessionTokenDigest(token), ROTATION_REASONS, transaction)
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
   *   它们用的是同一条会话）换令牌之前发出、之后才处理的请求不清除 Cookie（invalidatedByRotation）；
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
