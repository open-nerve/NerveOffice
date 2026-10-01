// 写操作没能确认结果之后的共用做法（M2-P6 复核第二批 G-2；第三批 S-a、G-a）：确认的弹窗、管理界面的弹窗、成员的角色与空间页头的改名共用，
// 不逐处各写一遍。
import { messages } from '../i18n/index.ts'
import { isUnknownOutcome } from './client.ts'
import { describeError } from './describe-error.ts'

/**
 * 结果未知之后的刷新最多等多久（M2-P6 复核第三批 S-a）：与按需加载的部署检测相同（app/chunk-load.ts 的 DEPLOYMENT_CHECK_TIMEOUT_MS）。
 * 写操作没能确认结果，多半是服务端或代理出了问题，随后的刷新也可能一直不回来；界面等着它，弹窗就一直停在"正在处理…"、关不掉，
 * 说明也不出现。到了时限就按没能刷新说明；刷新本身照常在后台继续，回来之后页面随之更新
 */
export const OUTCOME_REFRESH_TIME_LIMIT_MS = 10_000

/**
 * 在时限之内刷新（M2-P6 复核第三批 S-a）：refresh 兑现了为 true（页面已按服务端现在的状态刷新）；refresh 拒绝（刷新失败）、
 * 或者到了时限还没回来为 false。refresh 在刷新失败时要拒绝（第三批 G-a）：TanStack Query 的 invalidateQueries 默认吞掉重新请求的失败，
 * 用 shared/lib/refresh-queries.ts 的 refreshQueries
 */
export async function refreshWithin(refresh: () => Promise<unknown>, timeLimitMs: number = OUTCOME_REFRESH_TIME_LIMIT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, timeLimitMs, false)
  })
  try {
    return await Promise.race([refresh().then(() => true, () => false), timedOut])
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * 写操作失败之后：结果未知（isUnknownOutcome：网络、5xx、回包读不出来）时操作可能已经生效，先在时限之内重新请求显示它的那些查询
 * （refreshWithin），页面随之是服务端现在的状态，再交给界面说明。停用与启用、改系统角色、解除锁定、归档与恢复、全员可见、作废邀请、
 * 移出成员、改名与调整角色都按状态幂等，再试是安全的；只是不刷新的话，表格会停在旧的状态，看不出其实已经生效了。
 * 兑现为结果未知、而且页面已经刷新好了：说明里据此说"已刷新"还是"没能刷新"（writeFailureText，第三批 G-a）。
 * 确定的失败（4xx、服务端自己回答的 503）不在这里刷新——没有生效，页面上的状态没有变——兑现为 false，说明里用不到它
 */
export async function refreshIfUnknown(error: unknown, refresh: () => Promise<unknown>, timeLimitMs?: number): Promise<boolean> {
  if (!isUnknownOutcome(error))
    return false
  return refreshWithin(refresh, timeLimitMs)
}

/**
 * 失败的说明（与 refreshIfUnknown 配套，refreshed 是它的结果）：结果未知时说"可能已经生效"——页面已经刷新的，看得出是否已经生效；
 * 刷新失败或者到了时限还没回来的，说页面显示的可能还是之前的状态（M2-P6 复核第三批 G-a）。其余按错误码
 */
export function writeFailureText(error: unknown, refreshed: boolean): string {
  const reason = describeError(error).message
  if (!isUnknownOutcome(error))
    return reason
  return refreshed ? messages.common.outcomeUnknown(reason) : messages.common.outcomeUnknownNotRefreshed(reason)
}
