// 编辑租约的令牌经请求头传递（M3-P1 设计 §3.2）：不进地址与日志（日志本来就不记请求头）。心跳、释放与之后的保存（S4）
// 在控制器里用 @EditLeaseToken() 取得。规范不允许 @Headers()（不经校验）：这个参数装饰器自己按契约的格式校验，
// 全局的校验管道不校验自己写的参数装饰器（validateCustomDecorators 关着），自己写的参数装饰器由审查保证（架构总览 §5）。
import type { ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import { EDIT_LEASE_HEADER, editLeaseTokenSchema } from '@nerve-office/contracts'
import { createParamDecorator } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'

/**
 * 请求带来的令牌：没带这个请求头时为 undefined（按"没有租约"处理，P1 设计 §3.2）；带了却不是 43 个 base64url 字符
 * （包括空值、重复的请求头被合成的一串）是请求不合法，400 REQUEST_INVALID——说明里只写请求头的名字，不回显取值
 */
export function editLeaseTokenOf(request: Request): string | undefined {
  const value = request.headers[EDIT_LEASE_HEADER]
  if (value === undefined)
    return undefined
  const parsed = editLeaseTokenSchema.safeParse(value)
  if (!parsed.success)
    throw new AppError('REQUEST_INVALID', `请求参数不合法：${EDIT_LEASE_HEADER}`)
  return parsed.data
}

/** 控制器的参数装饰器：`renew(@EditLeaseToken() token: string | undefined)` */
export const EditLeaseToken = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined =>
  editLeaseTokenOf(context.switchToHttp().getRequest<Request>()))
