/* eslint-disable perfectionist/sort-imports -- CSP 要求关闭 JIT 先于契约构造；三浏览器回归验证这个执行顺序。 */
// 错误契约也会在测试构建的独立请求分块中求值，显式依赖初始化，不能仅依赖页面入口的导入次序。
import '../lib/zod-jitless.ts'
import { sessionExpiredDetailsSchema } from '@nerve-office/contracts'
import { ApiError } from './api-errors.ts'

/** 网络边界校验错误；存储协调只消费这些事实，不反向依赖请求实现或 zod。 */
export function sessionFailureOf(error: unknown): { readonly kind: 'disabled', readonly userId: string } | { readonly kind: 'preserve' } | undefined {
  if (!(error instanceof ApiError))
    return undefined
  if (error.status === 401 && error.code === 'SESSION_EXPIRED') {
    const details = sessionExpiredDetailsSchema.safeParse(error.details)
    return details.success && details.data.reason === 'account_disabled' ? { kind: 'disabled', userId: details.data.userId } : { kind: 'preserve' }
  }
  if ((error.status === 401 && error.code === 'UNAUTHENTICATED') || (error.status === 403 && error.code === 'CSRF_TOKEN_INVALID'))
    return { kind: 'preserve' }
  return undefined
}

/** 仅返回经错误契约确认的停用账户，供界面说明；本机删除仍须另外核对原请求许可。 */
export function disabledSessionUserId(error: unknown): string | undefined {
  const failure = sessionFailureOf(error)
  return failure?.kind === 'disabled' ? failure.userId : undefined
}
