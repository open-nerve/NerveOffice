import { ONE_TIME_LINK_PAGE_PATHS } from '@nerve-office/contracts'

/** 本人账户的页面地址（M2-P1 设计 §3.8） */
export const CHANGE_PASSWORD_PATH = '/settings/password'

const ONE_TIME_LINK_PAGES: ReadonlySet<string> = new Set(Object.values(ONE_TIME_LINK_PAGE_PATHS))

/** 是不是一次性链接的公开页面（接受邀请、重置密码）。路由的匹配不区分大小写，也不管末尾的斜杠，这里一样 */
export function isOneTimeLinkPage(pathname: string): boolean {
  return ONE_TIME_LINK_PAGES.has(pathname.toLowerCase().replace(/\/+$/, ''))
}
