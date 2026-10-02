import type { AppLogger } from '../logging/index.ts'
import type { AttemptTicket } from './attempt-throttle.ts'
import { AppError } from '../../shared/errors/app-error.ts'
import { databaseBusyReasonOf } from '../database/index.ts'
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
 * 交回这次占的名额，尽力而为：失败（例如数据库繁忙）只记日志，这次尝试按一次失败计，回答照旧（审查 A11）。
 * settle 是退回名额（ticket.abandoned），或者不在事务里的成功（ticket.succeeded：查看链接确认可用时）
 */
export async function settleQuietly(settle: () => Promise<void>, logger: AppLogger): Promise<void> {
  try {
    await settle()
  }
  catch (error) {
    logger.warn('退回登录限流的名额失败，这次尝试按一次失败计', { err: error })
  }
}

/**
 * 执行尝试里的一步，这一步出错时还没有得出"猜错"的结论（M2-P6 第 3 片复验 建议 1）：比对之前读凭据或链接的记录、比对本身
 * （等待哈希），或者已经确认是对的之后算新密码的哈希、执行成功的那个事务。遇到繁忙时这次不按失败计，尽力退回名额：
 * - 等待哈希的请求太多（DEF-015）：503 与 Retry-After，只记日志、不写审计；
 * - 数据库繁忙（等锁超时、语句超时、取不到连接）：原样抛出，由异常过滤器回 503 带 Retry-After。
 * 否则持续繁忙时，拿着正确的密码或有效的链接重试的人，会被自己的重试锁在门外（重试 5 次就锁定）。
 * 这一步要么还没比对，要么已经确认是对的，退回名额不会让任何人借繁忙多猜一次；判定为猜错之后的步骤（写失败的审计）不经这里，
 * 那时遇到繁忙照样按一次失败计。其他错误原样抛出，名额不退回，按一次失败计
 */
export async function releasingIfBusy<T>(ticket: AttemptTicket, logger: AppLogger, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  }
  catch (error) {
    if (error instanceof PasswordHashingBusyError) {
      await settleQuietly(async () => ticket.abandoned(), logger)
      logger.warn('等待密码哈希的请求太多，拒绝这次请求', { retryAfterSeconds: error.retryAfterSeconds })
      throw hashingBusy(error)
    }
    if (databaseBusyReasonOf(error) !== undefined)
      await settleQuietly(async () => ticket.abandoned(), logger)
    throw error
  }
}
