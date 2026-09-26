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
}

/** 服务端会话（P3 设计 §3.5）：令牌在 Cookie 里，库里只有摘要；空闲与绝对过期都用数据库时间判断。 */
@Injectable()
export class SessionService {
  constructor(
    private readonly repository: SessionsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 登录时新建：每次都是新的令牌（防会话固定）；顺带清理一小批早已过期的会话。 */
  async create(userId: string, transaction?: Transaction): Promise<CreatedSession> {
    const token = generateSessionToken()
    const { idleTimeoutMinutes, absoluteTimeoutMinutes } = this.config.session
    const { id } = await this.repository.insert({
      userId,
      tokenHash: sessionTokenDigest(token),
      idleMinutes: idleTimeoutMinutes,
      absoluteMinutes: absoluteTimeoutMinutes,
    }, transaction)
    await this.repository.purgeExpired(transaction)
    return { id, token }
  }

  /** 每个请求：令牌对应的会话仍然有效时返回它；距上次记录超过 1 分钟时顺延空闲过期。 */
  async authenticate(token: string): Promise<AuthenticatedSession | undefined> {
    if (!isWellFormedSessionToken(token))
      return undefined
    const session = await this.repository.findActive(sessionTokenDigest(token))
    if (session === undefined)
      return undefined
    if (session.stale)
      await this.repository.touch(session.id, this.config.session.idleTimeoutMinutes)
    return { id: session.id, userId: session.userId }
  }

  async revoke(sessionId: string, reason: 'logout', transaction?: Transaction): Promise<void> {
    await this.repository.revoke({ id: sessionId }, reason, transaction)
  }

  /** 同一个浏览器重新登录：原来的会话作废（原因 replaced）。令牌不合法或会话已失效时什么都不做。 */
  async replace(token: string, transaction?: Transaction): Promise<void> {
    if (isWellFormedSessionToken(token))
      await this.repository.revoke({ tokenHash: sessionTokenDigest(token) }, 'replaced', transaction)
  }
}
