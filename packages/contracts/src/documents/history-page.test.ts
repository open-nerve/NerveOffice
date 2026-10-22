import { describe, expect, it } from 'vitest'
import { documentIdFromPagePath } from './document-page.ts'
import { HISTORY_PAGE_ROUTE, HISTORY_PREVIEW_PAGE_PATTERN, historyIdsFromPagePath, historyPagePath, historyPreviewPagePath } from './history-page.ts'

const DOC = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const HISTORY = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
describe('US-M5-10 独立历史地址', () => {
  it('列表走平台，预览包含源与历史两重身份，不能误进当前编辑器', () => {
    expect(HISTORY_PAGE_ROUTE).toBe('/documents/:id/history')
    expect(historyPagePath(DOC)).toBe(`/documents/${DOC}/history`)
    const preview = `/documents/${DOC}/history/${HISTORY}/preview`
    expect(historyPreviewPagePath(DOC, HISTORY)).toBe(preview)
    expect(historyIdsFromPagePath(preview)).toEqual({ documentId: DOC, historyId: HISTORY })
    expect(historyIdsFromPagePath(preview.toUpperCase())).toEqual({ documentId: DOC.toUpperCase(), historyId: HISTORY.toUpperCase() })
    expect(documentIdFromPagePath(preview)).toBeUndefined()
  })
  it.each([`/documents/${DOC}`, `/documents/${DOC}/history`, `/documents/${DOC}/history/${HISTORY}`, `/documents/${DOC}/history/no/preview`, `/documents/no/history/${HISTORY}/preview`, `/documents/${DOC}/history/${HISTORY}/preview/`, `/documents/${DOC}/history/${HISTORY}/preview.js`])('不把其他地址分配到预览：%s', (path) => {
    expect(HISTORY_PREVIEW_PAGE_PATTERN.test(path)).toBe(false)
    expect(historyIdsFromPagePath(path)).toBeUndefined()
  })
})
