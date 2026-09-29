/**
 * 管理界面的页面地址（M2-P1 设计 §3.8，M2-P2 设计 §3.10）。放在 shared：页头的入口与成员页要用它，
 * 而管理界面本身按需加载，不能为了一个常量把它静态引进首屏包。
 */
export const ADMIN_PATH = '/admin'

export const ADMIN_PATHS = {
  users: `${ADMIN_PATH}/users`,
  invitations: `${ADMIN_PATH}/invitations`,
  spaces: `${ADMIN_PATH}/spaces`,
  audit: `${ADMIN_PATH}/audit`,
} as const

/** 路由表里停用者的文档转移页 */
export const ADMIN_USER_DOCUMENTS_ROUTE = `${ADMIN_PATH}/users/:userId/documents`

export function adminUserDocumentsPath(userId: string): string {
  return `${ADMIN_PATH}/users/${userId}/documents`
}
