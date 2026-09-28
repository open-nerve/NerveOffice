import { SetMetadata } from '@nestjs/common'

/** 路由元数据的键：auth 的会话守卫读取它。 */
export const SYSTEM_ADMIN_ROUTE = 'nerve-office:system-admin-route'

/**
 * 只给系统管理员的接口（M2-P1 设计 §3.1）：会话守卫在认证之后检查，不是系统管理员时 PERMISSION_DENIED。
 * 与 @Public() 一样只是一条元数据，放在 shared：用它的模块（admin）不必为此依赖 auth 的内部。
 */
export function SystemAdminOnly(): ClassDecorator & MethodDecorator {
  return SetMetadata(SYSTEM_ADMIN_ROUTE, true)
}
