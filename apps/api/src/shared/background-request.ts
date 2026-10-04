import { SetMetadata } from '@nestjs/common'

/** 路由元数据的键：auth 的会话守卫读取它。 */
export const BACKGROUND_REQUEST_ROUTE = 'nerve-office:background-request'

/**
 * 页面在后台定时发的请求（M3-P2 设计 §3.2，DEF-043）：阅读页每 30 秒读一次编辑状态、编辑时每 10 秒的心跳。
 * 会话守卫照常认证、检查账户与系统角色，只是不顺延登录的空闲过期——页面开着、人却不在时，登录照样按空闲到期，
 * 不会被定时请求一直续着。用户自己的操作（打开、保存、整理）照常顺延。CSRF 与 Origin 的检查与它无关，照旧。
 * 只用在方法上：是不是后台请求是一个接口的性质，不是一组接口的。
 * 与 @Public() 一样只是一条元数据，放在 shared：用它的模块（workspace）不必为此依赖 auth 的内部
 */
export function BackgroundRequest(): MethodDecorator {
  return SetMetadata(BACKGROUND_REQUEST_ROUTE, true)
}
