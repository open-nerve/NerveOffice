import type { OneTimeLinkPurpose } from '@nerve-office/contracts'
import type { AppConfig } from '../config/index.ts'
import type { AttemptAdmission, AttemptTicket, ThrottleDimension } from './attempt-throttle.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { AttemptThrottle } from './attempt-throttle.ts'
import { LoginThrottleRepository } from './login-throttle.repository.ts'
import { accountAddressKey, accountDigest, addressKey, keyDigest, linkAddressKey, linkRecordKey } from './throttle-keys.ts'

/** 一次登录尝试的来源：规范化之后的用户名与客户端地址。 */
export interface LoginAttempt {
  readonly username: string
  readonly clientIp?: string
}

/** 放行的尝试占到的名额。验证失败时不用交回，计为一次失败；成功时清除两个账户相关的维度的计数，退回地址维度的名额 */
export type LoginTicket = AttemptTicket
export type Admission = AttemptAdmission

/**
 * 登录限流（P3 设计 §3.5；M2-P6 复核 A1 改为三个维度）：各自一个窗口内的失败次数，达到上限就锁定。
 * - 账户与地址（用户名 + 客户端地址）：上限小（默认 5 次），只锁这个组合。别人从他那里锁不住你：
 *   原来只按用户名计数，任何人从任何地方连错 5 次，本人用正确的密码也登录不了，还能无限续期；
 * - 账户（只按用户名）：上限宽得多（默认 50 次），挡住从很多来源同时猜同一个账户；达到后这个账户在所有来源上都被锁定，
 *   系统管理员可以解除（LoginLockouts）；
 * - 地址（只按客户端地址）：不变，挡住同一个来源换着用户名猜。
 * 修改密码时猜旧密码也经这里（M2-P1 设计 §3.5）：与猜登录密码按同一套计数（用当前请求的地址）。
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
   * 固定的顺序：账户 → 账户与地址 → 地址。占名额按这个顺序，成功时的事务也按这个顺序锁这三行，互相等待时不会成环。
   * 两个账户相关的维度：成功之前的失败一笔勾销，行上记着所属账户（完成重置、管理员解除时按它一起清掉）。
   * 地址：只退回这次的名额，之前的失败照算，免得有人夹着自己账户的成功登录，继续尝试别的账户
   */
  private dimensionsOf(attempt: LoginAttempt): ThrottleDimension[] {
    const { maxFailures, accountMaxFailures, ipMaxFailures, windowMinutes, lockoutMinutes } = this.config.login
    const account = accountDigest(attempt.username)
    return [
      { name: 'account', keyHash: account, account, policy: { maxFailures: accountMaxFailures, windowMinutes, lockoutMinutes }, onSuccess: 'reset' },
      { name: 'account-address', keyHash: keyDigest(accountAddressKey(attempt.username, attempt.clientIp)), account, policy: { maxFailures, windowMinutes, lockoutMinutes }, onSuccess: 'reset' },
      { name: 'address', keyHash: keyDigest(addressKey(attempt.clientIp)), policy: { maxFailures: ipMaxFailures, windowMinutes, lockoutMinutes }, onSuccess: 'release' },
    ]
  }
}

/**
 * 一次性链接（邀请与重置密码）的尝试限流（M2-P1 设计 §3.4）：按客户端地址，键另起前缀，不与登录的计数混在一起；
 * 阈值沿用登录的地址维度。没有这个令牌算一次失败，可用就退回名额。
 * 找到了记录、只是不能用（过期、已用、已作废）时不计入地址的失败（M2-P6 复核 B3），另按这条记录计数（admitRejectedRecord）。
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

  /**
   * 同一条链接"找到了但不能用"又被打开了一次（M2-P6）：按这条记录计数，窗口与锁定时长沿用登录的，上限另行配置。
   * 这样的尝试每次都是一次失败（记录不会再变得可用），票据不用交回；达到上限之后这条链接一律拒绝，
   * 拿着真实的旧链接反复打开的人写不爆审计表，也不影响同一个地址的其他人与别的链接
   */
  async admitRejectedRecord(purpose: OneTimeLinkPurpose, recordId: string): Promise<Admission> {
    const { windowMinutes, lockoutMinutes } = this.config.login
    return this.#attempts.admit([
      { name: 'link-record', keyHash: keyDigest(linkRecordKey(purpose, recordId)), policy: { maxFailures: this.config.oneTimeLinks.recordMaxFailures, windowMinutes, lockoutMinutes }, onSuccess: 'release' },
    ])
  }
}
