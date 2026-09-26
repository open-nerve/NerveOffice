import type { CanActivate, ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import type { AppConfig } from '../config/index.ts'
import { CSRF_TOKEN_HEADER } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { APP_CONFIG } from '../config/index.ts'
import { principalOf } from './principal.ts'
import { csrfTokenMatches } from './session-token.ts'

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF 与 Origin 检查（全局守卫，排在会话守卫之后，P3 设计 §3.5），只管状态变更的请求：
 * - Origin 必须等于配置的公开地址，缺少也拒绝（浏览器对非 GET 请求都会带），公开的接口（登录）同样检查；
 * - 需要登录的接口，另外要求 X-CSRF-Token 等于由会话令牌派生的令牌。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    if (SAFE_METHODS.has(request.method))
      return true
    if (request.headers.origin !== this.config.http.publicOrigin)
      throw new AppError('ORIGIN_NOT_ALLOWED')
    const principal = principalOf(request)
    if (principal === undefined)
      return true
    const header = request.headers[CSRF_TOKEN_HEADER]
    if (!csrfTokenMatches(principal.csrfToken, typeof header === 'string' ? header : undefined))
      throw new AppError('CSRF_TOKEN_INVALID')
    return true
  }
}
