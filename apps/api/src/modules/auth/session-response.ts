import type { SessionResponse } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { User } from '../users/index.ts'
import { Injectable } from '@nestjs/common'
import { SpacesService } from '../spaces/index.ts'
import { csrfTokenFor } from './session-token.ts'

/** 新建了会话的结果：令牌只交给 Cookie，响应与登录相同 */
export interface LoginResult {
  readonly token: string
  readonly session: SessionResponse
}

/**
 * 会话的响应（P3 设计 §3.5）：账户、个人空间与 CSRF 令牌。登录、修改密码、接受邀请、完成重置与"当前会话"共用。
 * 新建了会话的写操作在它们的业务事务里调用、传入事务（M2-P6 第 3 片复验）：响应在提交之前拼好，提交之后不再访问数据库——
 * 提交之后才读的话，这一步遇到数据库繁忙时写入已经生效（密码换了、会话建了），却只能按"结果未知"回答
 */
@Injectable()
export class SessionResponses {
  constructor(private readonly spaces: SpacesService) {}

  /** 新建的会话（令牌）的响应：CSRF 令牌由新令牌派生 */
  async forNewSession(user: User, sessionToken: string, transaction: Transaction): Promise<LoginResult> {
    return { token: sessionToken, session: await this.describe(user, csrfTokenFor(sessionToken), transaction) }
  }

  async describe(user: User, csrfToken: string, transaction?: Transaction): Promise<SessionResponse> {
    const space = await this.spaces.personalSpaceOf(user.id, { transaction })
    // 个人空间随账户一起创建；没有说明数据不一致，按意外错误处理
    if (space === undefined)
      throw new Error(`账户没有个人空间：${user.id}`)
    return {
      user: { id: user.id, username: user.username, displayName: user.displayName, systemRole: user.systemRole },
      personalSpace: { id: space.id, name: space.name },
      csrfToken,
    }
  }
}
