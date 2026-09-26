import type { ErrorCode } from '@nerve-office/contracts'
import { ERROR_CODES } from '@nerve-office/contracts'
import { messages } from '../i18n/index.ts'
import { ApiError, NetworkError } from './client.ts'

function isKnownErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODES, code)
}

/** 给用户看的错误说明与请求标识（有的话）。 */
export interface ErrorDescription {
  readonly message: string
  readonly requestId?: string
}

export function describeError(error: unknown): ErrorDescription {
  if (error instanceof NetworkError)
    return { message: messages.errors.network }
  if (error instanceof ApiError) {
    if (error.code === 'TOO_MANY_ATTEMPTS' && error.retryAfterSeconds !== undefined)
      return { message: messages.errors.tooManyAttempts(Math.ceil(error.retryAfterSeconds / 60)), requestId: error.requestId }
    if (isKnownErrorCode(error.code))
      return { message: messages.errors.byCode(error.code, error.message), requestId: error.requestId }
    // 前端还不认识的错误码用服务端的说明；响应不是约定的格式时用通用说明
    return { message: error.code === 'UNKNOWN' ? messages.errors.unexpected : error.message, requestId: error.requestId }
  }
  return { message: messages.errors.unexpected }
}
