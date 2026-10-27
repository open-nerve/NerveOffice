import { historyPagePath } from './history-page.ts'

/** 独立只读预览的地址；两重 UUID 防止落入当前编辑器入口。 */
export const HISTORY_PREVIEW_PAGE_PATTERN = /^\/documents\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/history\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/preview$/i
export function historyPreviewPagePath(documentId: string, historyId: string): string {
  return `${historyPagePath(documentId)}/${historyId}/preview`
}
export function historyIdsFromPagePath(pathname: string): { documentId: string, historyId: string } | undefined {
  const match = HISTORY_PREVIEW_PAGE_PATTERN.exec(pathname)
  return match?.[1] === undefined || match[2] === undefined ? undefined : { documentId: match[1].toLowerCase(), historyId: match[2].toLowerCase() }
}
