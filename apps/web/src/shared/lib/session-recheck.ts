import type { ExpiredReason } from './login-path.ts'
import { createContext, use } from 'react'

/**
 * 向服务端确认现在是谁（ADR-008 的会话复核，由 app/runtime.ts 实现）：还是同一个人，换上新的会话（例如系统角色变了），页面不动；
 * 换了人或者已经退出，整页重新加载。确认结束（或者合并进正在进行的那一次）时兑现；网络等失败时页面照常。
 * 组件改了本人的账户之后用它（M2-P1 审查 B4）：例如管理员取消了自己的系统管理员、停用了自己。
 *
 * ifEnded：组件知道会话可能已经因为什么结束了，例如为自己生成重置链接的结果未知（M2-P6 复核第三批 R-1）。确认下来已经没有会话时，
 * 按这个原因回到登录页（登录页据此说明"你的密码可能已经失效"），而不是整页重新加载、登录页什么也不说；确认有结论之前，
 * 别的请求先得到"登录已过期"也按这个原因（与请求自带的原因一样，更具体的不被普通的"已过期"盖掉）
 */
export type SessionRecheck = (ifEnded?: ExpiredReason) => Promise<void>

/** 平台页面由应用的根组件提供（app/app.tsx） */
export const SessionRecheckContext = createContext<SessionRecheck | undefined>(undefined)

export function useSessionRecheck(): SessionRecheck {
  const recheck = use(SessionRecheckContext)
  if (recheck === undefined)
    throw new Error('会话复核由应用的根组件提供（app/app.tsx）')
  return recheck
}
