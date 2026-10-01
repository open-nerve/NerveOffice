// 写操作没能确认结果之后的共用做法（M2-P6 复核第二批 G-2）：确认的弹窗、管理界面的弹窗、成员的角色与空间页头的改名共用，不逐处各写一遍。
import { messages } from '../i18n/index.ts'
import { isUnknownOutcome } from './client.ts'
import { describeError } from './describe-error.ts'

/**
 * 写操作失败之后：结果未知（isUnknownOutcome：网络、5xx、回包读不出来）时操作可能已经生效，先重新请求显示它的那些查询，
 * 页面随之是服务端现在的状态，再交给界面说明。停用与启用、改系统角色、解除锁定、归档与恢复、全员可见、作废邀请、移出成员、
 * 改名与调整角色都按状态幂等，再试是安全的；只是不刷新的话，表格会停在旧的状态，看不出其实已经生效了。
 * 确定的失败（4xx、服务端自己回答的 503）不在这里刷新：没有生效，页面上的状态没有变
 */
export async function refreshIfUnknown(error: unknown, refresh: () => Promise<unknown>): Promise<void> {
  if (isUnknownOutcome(error))
    await refresh()
}

/** 失败的说明：结果未知时说"可能已经生效"（与 refreshIfUnknown 配套，页面已经刷新），其余按错误码 */
export function writeFailureText(error: unknown): string {
  const reason = describeError(error).message
  return isUnknownOutcome(error) ? messages.common.outcomeUnknown(reason) : reason
}
