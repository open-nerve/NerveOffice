import type { ErrorCode } from '@nerve-office/contracts'
import { ERROR_CODES } from '@nerve-office/contracts'

/** 错误的详情：随错误响应原样下发，结构按错误码约定（contracts 里的结构，例如修订号冲突的 revisionConflictDetailsSchema）。 */
export type ErrorDetails = Readonly<Record<string, unknown>>

export interface AppErrorOptions extends ErrorOptions {
  /** 随错误响应一起下发的响应头，例如 429 的 Retry-After */
  headers?: Readonly<Record<string, string>>
  /** 随错误响应一起下发的详情（ADR-006）：只放客户端据此决策的数据，不放内部细节 */
  details?: ErrorDetails
}

/**
 * 业务错误（规范 §2.3，ADR-006）：带错误码，由全局异常过滤器映射为统一的错误响应。
 * message 会原样返回给客户端：只写面向用户的说明，不含内部细节；不写时用登记表里的默认说明。
 */
export class AppError extends Error {
  override readonly name = 'AppError'
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly details: ErrorDetails | undefined

  constructor(readonly code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    const { headers = {}, details, ...errorOptions } = options
    super(message ?? ERROR_CODES[code].message, errorOptions)
    this.status = ERROR_CODES[code].status
    this.headers = headers
    this.details = details
  }
}
