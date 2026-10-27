/** 平台历史列表的地址；预览专用的地址与身份解析放在 history-preview-page.ts，避免进入平台首屏。 */
export const HISTORY_PAGE_ROUTE = '/documents/:id/history'
export function historyPagePath(documentId: string): string {
  return `/documents/${documentId}/history`
}
