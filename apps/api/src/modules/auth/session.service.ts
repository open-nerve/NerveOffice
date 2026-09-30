import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { generateSessionToken, isWellFormedSessionToken, sessionTokenDigest } from './session-token.ts'
import { SessionsRepository } from './sessions.repository.ts'

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

  /** 距上次记录超过 1 分钟时顺延空闲过期（不超过绝对过期） */
  async keepAlive(session: AuthenticatedSession): Promise<void> {
    if (session.stale)
      await this.repository.touch(session.id, this.config.session.idleTimeoutMinutes)
  }

  /** 撤销一条会话：退出；或者会话守卫发现账户已不可用（disabled） */
  async revoke(sessionId: string, reason: 'logout' | 'disabled', transaction?: Transaction): Promise<void> {
    await this.repository.revoke({ id: sessionId }, reason, transaction)
  }

  /**
   * 撤销这个人的全部会话（M2-P1 设计 §3.5）：账户停用、签发与完成重置、修改密码时全部撤销。修改密码不保留当前的会话，
   * 而是随后为当前页面新建一个（M2-P6 复核 B1：换掉令牌，偷到的 Cookie 随之失效）。
   * 调用方的事务先锁住账户的行（UsersService.lockAccount 等）：登录的事务复核时也锁这一行，
   * 两边一先一后，这里撤销的包括先提交的登录新建的会话（审查 A1）。会话守卫对每个请求另查账户状态。
   */
  async revokeAllOf(
    userId: string,
    reason: 'disabled' | 'password_changed' | 'password_reset',
    options: { readonly transaction?: Transaction } = {},
  ): Promise<void> {
    await this.repository.revokeAllOfUser(userId, reason, options.transaction)
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
