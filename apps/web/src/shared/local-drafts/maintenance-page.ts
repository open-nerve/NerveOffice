import { LOCAL_DRAFTS_PATH } from '../lib/local-drafts-path.ts'

/** 只决定后台是否参与；前台恢复仍自行核对真实会话、权限、原件及编辑权。 */
export function maintenanceIncludes(pathname: string, documentId: string): boolean {
  const path = pathname.replace(/\/+$/, '')
  return path !== LOCAL_DRAFTS_PATH && path !== `/documents/${documentId}`
}
