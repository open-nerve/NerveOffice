import { createContext, use } from 'react'

/**
 * 请求得到"登录已过期"之后，换上浏览器里同一个人的新会话（ADR-008 的会话处理，由 app/runtime.ts 实现，M2-P6 复验 一般-4）。
 * 同一个浏览器刚修改了密码或重新登录时，换令牌之前发出、之后才处理的请求得到"登录已过期"，服务端不清除 Cookie，浏览器里已是新的会话。
 * 先等本页的登录、修改密码结束，再向服务端要一次会话：还是页面上的这个人，换上新的会话与 CSRF 令牌，兑现为 true；
 * 没有会话、换了人、页面已经在离开，兑现为 false（不跳转、不重新加载，由调用方按原来的结果处理）。网络等失败原样抛出。
 * 退出用它（features/auth 的 logout）：退出得到"登录已过期"时，浏览器里的新会话还在，要带着新的令牌再退出一次
 */
export type AdoptRenewedSession = () => Promise<boolean>

/** 平台页面由应用的根组件提供（app/app.tsx） */
export const AdoptRenewedSessionContext = createContext<AdoptRenewedSession | undefined>(undefined)

export function useAdoptRenewedSession(): AdoptRenewedSession {
  const adopt = use(AdoptRenewedSessionContext)
  if (adopt === undefined)
    throw new Error('换上新会话的处理由应用的根组件提供（app/app.tsx）')
  return adopt
}
