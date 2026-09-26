import type { ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import type { AuditOrigin } from './audit-event.ts'
import { createParamDecorator } from '@nestjs/common'
import { requestIdOf } from '../logging/index.ts'
import { clientIpSchema } from './audit-event.ts'

/**
 * 从请求取审计来源：请求标识与客户端地址（经 trust proxy 识别反向代理转发的地址）。
 * 地址不是能存进数据库的 IP（例如带作用域的 IPv6、代理转发来的非 IP 值）时不写，
 * 审计不能因为它失败，连带业务操作返回 500（审查 A19）。
 */
export function originOf(request: Request): AuditOrigin {
  const clientIp = clientIpSchema.safeParse(request.ip)
  return { source: 'http', requestId: requestIdOf(request), ...(clientIp.success ? { clientIp: clientIp.data } : {}) }
}

/** 控制器的参数装饰器：`record(@RequestOrigin() origin: AuditOrigin)`。 */
export const RequestOrigin = createParamDecorator((_data: unknown, context: ExecutionContext): AuditOrigin =>
  originOf(context.switchToHttp().getRequest<Request>()))
