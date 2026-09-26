import type { Request } from 'express'

const USER_ID: unique symbol = Symbol('nerve-office:request-user-id')

interface RequestWithUser extends Request {
  [USER_ID]?: string
}

/**
 * 认证通过后调用（auth 的会话守卫）：之后这个请求里写的日志，以及请求结束时的那一条，都带上 userId（规范 §7）。
 * 请求上下文按需取 request.log，所以这里换掉 request.log 就够了。
 */
export function identifyRequestUser(request: Request, userId: string): void {
  (request as RequestWithUser)[USER_ID] = userId
  request.log = request.log.child({ userId })
}

/** 这个请求认证出的用户；没有登录的请求返回 undefined。 */
export function requestUserId(request: Request): string | undefined {
  return (request as RequestWithUser)[USER_ID]
}
