/**
 * 空间的页面地址（M2-P2 设计 §3.10）。放在 shared：导航、空间页、按需加载的成员页、管理界面与编辑器页都要用它。
 * 本人的个人空间就是首页（"我的空间"）；任何空间（包括本人的个人空间）也都能用 /spaces/{id} 打开。
 */
export const HOME_PATH = '/'

/** 路由表里的空间页与成员页（相对于外框） */
export const SPACE_ROUTE = 'spaces/:spaceId'
export const SPACE_MEMBERS_ROUTE = 'spaces/:spaceId/members'

export function spacePath(spaceId: string): string {
  return `/spaces/${spaceId}`
}

export function spaceMembersPath(spaceId: string): string {
  return `/spaces/${spaceId}/members`
}
