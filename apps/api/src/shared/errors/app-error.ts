import type { ErrorCode } from '@nerve-office/contracts'
import { ERROR_CODES } from '@nerve-office/contracts'

/**
 * 业务错误（规范 §2.3，ADR-006）：带错误码，由全局异常过滤器映射为统一的错误响应。
 * message 会原样返回给客户端：只写面向用户的说明，不含内部细节；不写时用登记表里的默认说明。
 */
export class AppError extends Error {
  override readonly name = 'AppError'
  readonly status: number

  constructor(readonly code: ErrorCode, message?: string, options?: ErrorOptions) {
    super(message ?? ERROR_CODES[code].message, options)
    this.status = ERROR_CODES[code].status
  }
}
