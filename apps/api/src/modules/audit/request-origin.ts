import type { ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import type { AuditOrigin } from './audit-event.ts'
import { createParamDecorator } from '@nestjs/common'
import { requestIdOf } from '../logging/index.ts'

/** 从请求取审计来源：请求标识与客户端地址（经 trust proxy 识别反向代理转发的地址）。 */
export function originOf(request: Request): AuditOrigin {
  return { source: 'http', requestId: requestIdOf(request), ...(request.ip === undefined ? {} : { clientIp: request.ip }) }
}

/** 控制器的参数装饰器：`record(@RequestOrigin() origin: AuditOrigin)`。 */
export const RequestOrigin = createParamDecorator((_data: unknown, context: ExecutionContext): AuditOrigin =>
  originOf(context.switchToHttp().getRequest<Request>()))
