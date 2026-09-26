import type { Buffer } from 'node:buffer'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { LockedForSeconds } from './login-throttle.repository.ts'
import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { LoginThrottleRepository } from './login-throttle.repository.ts'

/** 一次登录尝试的来源：规范化之后的用户名与客户端地址（没有合法地址时只按用户名）。 */
export interface LoginAttempt {
  readonly username: string
  readonly clientIp?: string
}

function keyHash(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest()
}

/**
 * 登录限流（P3 设计 §3.5）：按用户名与按客户端地址两个维度，各自一个窗口内的失败次数，达到上限就锁定。
 * 计数存在数据库里：重启不丢，将来多实例也共用。
 */
@Injectable()
export class LoginThrottle {
  constructor(
    private readonly repository: LoginThrottleRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 验证密码之前先查：任一维度锁定中，返回还要多久解锁。 */
  async lockedFor(attempt: LoginAttempt): Promise<LockedForSeconds> {
    return this.repository.lockedFor(this.keys(attempt).map(key => key.hash))
  }

  /** 验证失败：两个维度各记一次，顺带清理一小批过期的计数。返回因此锁定的时长（取两个维度里较长的）。 */
  async recordFailure(attempt: LoginAttempt, transaction?: Transaction): Promise<LockedForSeconds> {
    const { windowMinutes, lockoutMinutes } = this.config.login
    let locked: LockedForSeconds
    for (const key of this.keys(attempt)) {
      const seconds = await this.repository.recordFailure(key.hash, { maxFailures: key.maxFailures, windowMinutes, lockoutMinutes }, transaction)
      if (seconds !== undefined)
        locked = Math.max(locked ?? 0, seconds)
    }
    await this.repository.purgeExpired(windowMinutes, transaction)
    return locked
  }

  /** 登录成功：只清除这个用户名的计数。地址的计数不清，免得攻击者夹着自己账户的成功登录继续尝试别的账户 */
  async succeeded(attempt: LoginAttempt, transaction?: Transaction): Promise<void> {
    await this.repository.reset(keyHash(`user:${attempt.username}`), transaction)
  }

  private keys(attempt: LoginAttempt): { hash: Buffer, maxFailures: number }[] {
    const keys = [{ hash: keyHash(`user:${attempt.username}`), maxFailures: this.config.login.maxFailures }]
    if (attempt.clientIp !== undefined)
      keys.push({ hash: keyHash(`ip:${attempt.clientIp}`), maxFailures: this.config.login.ipMaxFailures })
    return keys
  }
}
