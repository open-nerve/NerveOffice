// 会话 Cookie（P3 设计 §3.5）。
import type { CookieOptions, Response } from 'express'
import { isWellFormedSessionToken } from './session-token.ts'

/**
 * Cookie 的名称与属性，按公开地址决定：
 * - HTTPS：带 Secure，名称用 __Host- 前缀（浏览器强制 Secure、Path=/、不带 Domain，子域写不了它）；
 * - 本机调试的 HTTP：不带 Secure（配置只在这时允许 HTTP）。
 * Max-Age 取绝对过期时长：关掉浏览器再打开仍然登录，过期由服务端判断。
 */
export class SessionCookieSettings {
  readonly name: string
  readonly secure: boolean

  constructor(publicOrigin: string, readonly maxAgeMs: number) {
    this.secure = publicOrigin.startsWith('https:')
    this.name = this.secure ? '__Host-nerve_session' : 'nerve_session'
  }

  /** 从请求的 Cookie 头里取会话令牌；没有，或者格式不对（不是我们发的）时返回 undefined。 */
  read(cookieHeader: string | undefined): string | undefined {
    for (const pair of cookieHeader?.split(';') ?? []) {
      const separator = pair.indexOf('=')
      if (separator === -1 || pair.slice(0, separator).trim() !== this.name)
        continue
      const value = pair.slice(separator + 1).trim()
      return isWellFormedSessionToken(value) ? value : undefined
    }
    return undefined
  }

  /** 名称存在就算"带着会话"，即使值不合法：过期提示与清除都按它判断。 */
  isPresent(cookieHeader: string | undefined): boolean {
    return cookieHeader?.split(';').some(pair => pair.split('=')[0]?.trim() === this.name) ?? false
  }

  private attributes(): CookieOptions {
    return { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/' }
  }

  write(response: Response, token: string): void {
    response.cookie(this.name, token, { ...this.attributes(), maxAge: this.maxAgeMs })
  }

  clear(response: Response): void {
    response.clearCookie(this.name, this.attributes())
  }
}
