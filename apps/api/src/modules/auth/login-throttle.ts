import type { AppConfig } from '../config/index.ts'
import type { AttemptAdmission, AttemptTicket, ThrottleDimension } from './attempt-throttle.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { AttemptThrottle } from './attempt-throttle.ts'
import { LoginThrottleRepository } from './login-throttle.repository.ts'
import { addressKey, keyDigest, linkAddressKey, usernameKey } from './throttle-keys.ts'

/** 一次登录尝试的来源：规范化之后的用户名与客户端地址。 */
export interface LoginAttempt {
  readonly username: string
  readonly clientIp?: string
}

/** 放行的尝试占到的名额。验证失败时不用交回，计为一次失败；成功时清除用户名的计数，退回地址维度的名额 */
export type LoginTicket = AttemptTicket
export type Admission = AttemptAdmission

/**
 * 登录限流（P3 设计 §3.5）：按用户名与按客户端地址两个维度，各自一个窗口内的失败次数，达到上限就锁定。
 * 修改密码时猜旧密码也经这里（M2-P1 设计 §3.5）：与猜登录密码按同一个计数。
 */
@Injectable()
export class LoginThrottle {
  readonly #attempts: AttemptThrottle

  constructor(
    private readonly repository: LoginThrottleRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.#attempts = new AttemptThrottle(repository)
  }

  async admit(attempt: LoginAttempt): Promise<Admission> {
    return this.#attempts.admit(this.dimensionsOf(attempt))
  }

  /** 删除一小批过期的计数（登录与一次性链接的计数都在同一张表里）。在事务之外调用。 */
  async purgeExpired(): Promise<void> {
    await this.repository.purgeExpired(this.config.login.windowMinutes)
  }

  /**
   * 先用户名、再地址：成功时的事务按同一顺序锁这两行，互相等待时不会成环。
   * 用户名：成功之前的失败一笔勾销。地址：只退回这次的名额，之前的失败照算，
   * 免得攻击者夹着自己账户的成功登录，继续尝试别的账户
   */
  private dimensionsOf(attempt: LoginAttempt): ThrottleDimension[] {
    const { maxFailures, ipMaxFailures, windowMinutes, lockoutMinutes } = this.config.login
    return [
      { name: 'username', keyHash: keyDigest(usernameKey(attempt.username)), policy: { maxFailures, windowMinutes, lockoutMinutes }, onSuccess: 'reset' },
      { name: 'address', keyHash: keyDigest(addressKey(attempt.clientIp)), policy: { maxFailures: ipMaxFailures, windowMinutes, lockoutMinutes }, onSuccess: 'release' },
    ]
  }
}

/**
 * 一次性链接（邀请与重置密码）的尝试限流（M2-P1 设计 §3.4）：只按客户端地址，键另起前缀，不与登录的计数混在一起；
 * 阈值沿用登录的地址维度。令牌不可用算一次失败，可用就退回名额。
 */
@Injectable()
export class LinkThrottle {
  readonly #attempts: AttemptThrottle

  constructor(
    repository: LoginThrottleRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.#attempts = new AttemptThrottle(repository)
  }

  async admit(clientIp: string | undefined): Promise<Admission> {
    const { ipMaxFailures, windowMinutes, lockoutMinutes } = this.config.login
    return this.#attempts.admit([
      { name: 'link-address', keyHash: keyDigest(linkAddressKey(clientIp)), policy: { maxFailures: ipMaxFailures, windowMinutes, lockoutMinutes }, onSuccess: 'release' },
    ])
  }
}
