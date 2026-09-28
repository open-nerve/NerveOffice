import type { AppLogger } from '../logging/index.ts'
import type { AttemptTicket } from './attempt-throttle.ts'
import { AppError } from '../../shared/errors/app-error.ts'
import { PasswordHashingBusyError } from '../users/index.ts'

/** 尝试次数过多：429 与 Retry-After（至少 1 秒） */
export function tooManyAttempts(seconds: number): AppError {
  return new AppError('TOO_MANY_ATTEMPTS', undefined, { headers: { 'Retry-After': String(Math.max(1, seconds)) } })
}

/** 等待密码哈希的请求太多（DEF-015）：503 与 Retry-After */
export function hashingBusy(error: PasswordHashingBusyError): AppError {
  return new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error, headers: { 'Retry-After': String(error.retryAfterSeconds) } })
}

/**
 * 执行要用密码哈希的一步（验证或计算新哈希）。等待哈希的请求太多时（DEF-015）：退回名额，返回 503 与 Retry-After，
 * 只记日志、不写审计。其他错误原样抛出，名额不退回，按一次失败计。
 */
export async function withHashing<T>(ticket: AttemptTicket, logger: AppLogger, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  }
  catch (error) {
    if (!(error instanceof PasswordHashingBusyError))
      throw error
    // 退回名额失败（例如数据库出错）只记日志：这次按一次失败计，回应仍是"服务繁忙"（审查 A11）
    await ticket.abandoned().catch((releaseError: unknown) => {
      logger.warn('退回登录限流的名额失败，这次尝试按一次失败计', { err: releaseError })
    })
    logger.warn('等待密码哈希的请求太多，拒绝这次请求', { retryAfterSeconds: error.retryAfterSeconds })
    throw hashingBusy(error)
  }
}
