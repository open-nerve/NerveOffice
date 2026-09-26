import { SetMetadata } from '@nestjs/common'

/** 路由元数据的键：auth 的会话守卫读取它。 */
export const PUBLIC_ROUTE = 'nerve-office:public-route'

/**
 * 不需要登录的接口（登录、存活与就绪探针）。其他接口一律要求登录（默认拒绝，P3 设计 §3.5）。
 * 放在 shared：它只是一条元数据，用它的模块不必依赖 auth。
 */
export function Public(): ClassDecorator & MethodDecorator {
  return SetMetadata(PUBLIC_ROUTE, true)
}
