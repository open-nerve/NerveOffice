/** 仅保存中提示，不携带正文、凭据或编辑身份；旧单段键不再读取。 */
export const PENDING_SAVE_PREFIX = 'nerve-office:pending-save:'
export const RELOAD_PREFIX = 'nerve-office:reload:'
export const EDIT_REQUEST_PREFIX = 'nerve-office:edit-request:'

export function pendingSaveKey(userId: string, documentId: string): string {
  return `${PENDING_SAVE_PREFIX}${userId}:${documentId}`
}
