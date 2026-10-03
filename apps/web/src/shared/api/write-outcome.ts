// 写操作没能确认结果之后的共用做法（M2-P6 复核第二批 G-2；第三批 S-a、G-a；第四批）：确认的弹窗、管理界面的弹窗、成员的角色、
// 空间页头的改名，以及表单、面板与行内表单（创建团队空间、签发与重新生成邀请、添加成员、新建表格与文件夹、整理面板、回收站的恢复）共用，
// 不逐处各写一遍。说明里"列表刷新了没有"那一句由 shared/i18n 的 messages.common.listRefreshed 给出。
// 写操作成功之后的刷新同样在这里（refreshAfterSuccess，Codex 对抗评审 CX4）：与失败之后的刷新同一个时限，同样各处共用。
import { messages } from '../i18n/index.ts'
import { isUnknownOutcome } from './client.ts'
import { describeError } from './describe-error.ts'

/**
 * 结果未知之后的刷新最多等多久（M2-P6 复核第三批 S-a）：与按需加载的部署检测相同（app/chunk-load.ts 的 DEPLOYMENT_CHECK_TIMEOUT_MS）。
 * 写操作没能确认结果，多半是服务端或代理出了问题，随后的刷新也可能一直不回来；界面等着它，弹窗就一直停在"正在处理…"、关不掉，
 * 说明也不出现。到了时限就按没能刷新说明；刷新本身照常在后台继续，回来之后页面随之更新
 */
export const OUTCOME_REFRESH_TIME_LIMIT_MS = 10_000

export interface RefreshWithinOptions {
  /** 等刷新的时限，默认 OUTCOME_REFRESH_TIME_LIMIT_MS */
  readonly timeLimitMs?: number
  /**
   * 到了时限还没回来的刷新，之后在后台成功了（M2-P6 复核第五批 G4）：说明已经按"没能刷新"给出，页面随后其实已经刷新好了，
   * 调用方据此把说法改回"已刷新"（shared/lib/use-outcome-refresh.ts）。之后失败了、或者在时限之内就有了结果，都不调用
   */
  readonly onLateRefresh?: () => void
}

/**
 * 在时限之内刷新（M2-P6 复核第三批 S-a）：refresh 兑现了为 true（页面已按服务端现在的状态刷新）；refresh 拒绝（刷新失败）、
 * 或者到了时限还没回来为 false。refresh 在刷新失败时要拒绝（第三批 G-a）：TanStack Query 的 invalidateQueries 默认吞掉重新请求的失败，
 * 用 shared/lib/refresh-queries.ts 的 refreshQueries。到了时限之后刷新在后台继续，成功了就调用 onLateRefresh（第五批 G4）
 */
export async function refreshWithin(refresh: () => Promise<unknown>, { timeLimitMs = OUTCOME_REFRESH_TIME_LIMIT_MS, onLateRefresh }: RefreshWithinOptions = {}): Promise<boolean> {
  const refreshing = refresh().then(() => true, () => false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const limit = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve(false)
    }, timeLimitMs)
  })
  const refreshed = await Promise.race([refreshing, limit])
  clearTimeout(timer)
  if (timedOut && onLateRefresh !== undefined) {
    void refreshing.then((late) => {
      if (late)
        onLateRefresh()
    })
  }
  return refreshed
}

/**
 * 写操作成功之后、到了时限还没有结果的刷新（Codex 对抗评审 CX4）：它在后台继续。说明里据此说列表还在刷新，有了结果（成功或失败）
 * 之后不再说（shared/ui/still-refreshing.tsx）。订阅的形状照 React 的 useSyncExternalStore
 */
export interface BackgroundRefresh {
  /** 有了结果没有 */
  readonly settled: () => boolean
  /** 有了结果时通知；返回取消订阅 */
  readonly subscribe: (listener: () => void) => () => void
}

/**
 * 写操作成功之后的刷新（Codex 对抗评审 CX4）。写入已经确定成功，这次操作的结束（弹窗关掉、说明写出、焦点交还）不再无限期地等列表刷新：
 * 原来刷新一直不回来时，确认框一直停在"正在处理…"，取消与 Esc 都关不掉。等刷新的时限与失败之后的相同（OUTCOME_REFRESH_TIME_LIMIT_MS）：
 * - 在时限之内有了结果（成功或失败）兑现为 undefined。刷新失败不算这次操作失败，由列表自己说明没能刷新、给出重试（shared/ui/refresh-problem.tsx，CX5）；
 * - 到了时限还没回来兑现为 BackgroundRefresh：刷新在后台继续，操作照常结束，说明里说列表还在刷新（与失败之后"到了时限先说明"对应）。
 * 界面要依赖刷新的结果才对的地方（例如取消分享之后那一行要先消失，焦点才能交给"已分享给"），调用方先按确定的写入结果直接改缓存，再来刷新。
 * 不拒绝
 */
export async function refreshAfterSuccess(refresh: () => Promise<unknown>, { timeLimitMs = OUTCOME_REFRESH_TIME_LIMIT_MS }: { readonly timeLimitMs?: number } = {}): Promise<BackgroundRefresh | undefined> {
  let settled = false
  const listeners = new Set<() => void>()
  const background: BackgroundRefresh = {
    settled: () => settled,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  // 刷新失败同样算有了结果：这里只等它结束，失败由列表自己说明。晚到的结果（成功或失败）经 refreshWithin 的 onLateRefresh 通知
  const inTime = await refreshWithin(async () => refresh().catch(() => undefined), {
    timeLimitMs,
    onLateRefresh: () => {
      settled = true
      for (const listener of listeners)
        listener()
    },
  })
  return inTime ? undefined : background
}

export interface RefreshIfUnknownOptions extends RefreshWithinOptions {
  /**
   * 结果未知之外也要刷新的失败（M2-P6 复核第四批）：确定的拒绝说明上一次多半已经生效——结果未知之后再试得到"已经是成员"、
   * "已有同名"、"登录名已被占用"，或者 requestId 已经用过（shared/api/request-ids.ts 的 earlierAttemptDone）。这时同样在时限之内刷新，
   * 说明同样按刷新好了没有说"已刷新"还是"没能刷新"
   */
  readonly also?: (error: unknown) => boolean
}

/**
 * 写操作失败之后：结果未知（isUnknownOutcome：网络、5xx、回包读不出来）时操作可能已经生效，先在时限之内重新请求显示它的那些查询
 * （refreshWithin），页面随之是服务端现在的状态，再交给界面说明。停用与启用、改系统角色、解除锁定、归档与恢复、全员可见、作废邀请、
 * 移出成员、改名与调整角色都按状态幂等，再试是安全的；只是不刷新的话，表格会停在旧的状态，看不出其实已经生效了。
 * options.also 认出的失败同样刷新（第四批）。
 * 兑现为刷新了、而且页面已经刷新好了：说明里据此说"已刷新"还是"没能刷新"（writeFailureText，第三批 G-a）。
 * 其余确定的失败（4xx、服务端自己回答的 503）不在这里刷新——没有生效，页面上的状态没有变——兑现为 false，说明里用不到它
 */
export async function refreshIfUnknown(error: unknown, refresh: () => Promise<unknown>, { also, ...within }: RefreshIfUnknownOptions = {}): Promise<boolean> {
  if (!isUnknownOutcome(error) && also?.(error) !== true)
    return false
  return refreshWithin(refresh, within)
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
