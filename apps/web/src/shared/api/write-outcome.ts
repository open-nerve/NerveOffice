// 写操作没能确认结果之后的共用做法（M2-P6 复核第二批 G-2；第三批 S-a、G-a；第四批）：确认的弹窗、管理界面的弹窗、成员的角色、
// 空间页头的改名，以及表单、面板与行内表单（创建团队空间、签发与重新生成邀请、添加成员、新建表格与文件夹、整理面板、回收站的恢复）共用，
// 不逐处各写一遍。说明里"列表刷新了没有"那一句由 shared/i18n 的 messages.common.listRefreshed 给出。
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

export interface RefreshIfUnknownOptions {
  /**
   * 结果未知之外也要刷新的失败（M2-P6 复核第四批）：确定的拒绝说明上一次多半已经生效——结果未知之后再试得到"已经是成员"、
   * "已有同名"、"登录名已被占用"，或者 requestId 已经用过（shared/api/request-ids.ts 的 earlierAttemptDone）。这时同样在时限之内刷新，
   * 说明同样按刷新好了没有说"已刷新"还是"没能刷新"
   */
  readonly also?: (error: unknown) => boolean
  /** 等刷新的时限，默认 OUTCOME_REFRESH_TIME_LIMIT_MS */
  readonly timeLimitMs?: number
}

/**
 * 写操作失败之后：结果未知（isUnknownOutcome：网络、5xx、回包读不出来）时操作可能已经生效，先在时限之内重新请求显示它的那些查询
 * （refreshWithin），页面随之是服务端现在的状态，再交给界面说明。停用与启用、改系统角色、解除锁定、归档与恢复、全员可见、作废邀请、
 * 移出成员、改名与调整角色都按状态幂等，再试是安全的；只是不刷新的话，表格会停在旧的状态，看不出其实已经生效了。
 * options.also 认出的失败同样刷新（第四批）。
 * 兑现为刷新了、而且页面已经刷新好了：说明里据此说"已刷新"还是"没能刷新"（writeFailureText，第三批 G-a）。
 * 其余确定的失败（4xx、服务端自己回答的 503）不在这里刷新——没有生效，页面上的状态没有变——兑现为 false，说明里用不到它
 */
export async function refreshIfUnknown(error: unknown, refresh: () => Promise<unknown>, { also, timeLimitMs }: RefreshIfUnknownOptions = {}): Promise<boolean> {
  if (!isUnknownOutcome(error) && also?.(error) !== true)
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
