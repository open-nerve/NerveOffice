/**
 * 管理界面的页面地址（M2-P1 设计 §3.8）。放在 shared：页头的入口要用它，而管理界面本身按需加载，
 * 不能为了一个常量把它静态引进首屏包。P2 加团队空间
 */
export const ADMIN_PATH = '/admin'

export const ADMIN_PATHS = {
  users: `${ADMIN_PATH}/users`,
  invitations: `${ADMIN_PATH}/invitations`,
  audit: `${ADMIN_PATH}/audit`,
} as const
