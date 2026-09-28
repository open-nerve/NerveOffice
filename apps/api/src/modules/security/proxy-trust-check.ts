import type { Request, RequestHandler } from 'express'
import type { AppConfig } from '../config/index.ts'
import type { AppLogger } from '../logging/index.ts'

export const UNTRUSTED_PROXY_WARNING = '反向代理转发来的请求不是 HTTPS：代理没有被信任（检查 NERVE_TRUST_PROXY）或者没有转发协议，客户端地址与 HSTS 都会出错'

/** 经反向代理转发的请求：带着代理加的转发头。容器的健康检查、本机的排查直接访问应用，不带 */
function viaProxy(request: Request): boolean {
  return request.headers['x-forwarded-for'] !== undefined || request.headers['x-forwarded-proto'] !== undefined
}

/**
 * 代理未被信任的自检（P5 设计 §3.5，DEF-014）：公开地址是 HTTPS，经代理转发来的请求却不是 HTTPS（request.secure 为假），
 * 说明应用没有采信代理的转发头：客户端地址是代理的地址（登录限流按地址的维度、审计里的地址都会错），HSTS 也不会下发。
 * 每个进程只记一条告警，不影响请求。
 */
export function proxyTrustCheck(http: Pick<AppConfig['http'], 'publicOrigin' | 'trustProxy'>, logger: AppLogger): RequestHandler {
  let reported = new URL(http.publicOrigin).protocol !== 'https:'
  return (request, _response, next) => {
    if (!reported && !request.secure && viaProxy(request)) {
      reported = true
      logger.warn(UNTRUSTED_PROXY_WARNING, {
        publicOrigin: http.publicOrigin,
        trustProxy: http.trustProxy,
        peerAddress: request.socket.remoteAddress,
        forwardedProto: request.headers['x-forwarded-proto'],
      })
    }
    next()
  }
}
