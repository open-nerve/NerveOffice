export const LOGOUT_PATH = '/logout'

/** 结果页自行拥有固定来源的退出，不允许全局复核把新登录借给旧操作。 */
export function isLogoutPage(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === LOGOUT_PATH
}
