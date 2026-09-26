import { describe, expect, it } from 'vitest'
import { DOCUMENT_PAGE_PATTERN, documentIdFromPagePath, documentPagePath } from './document-page.ts'

const ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'

describe('编辑器页的地址', () => {
  it('/documents/<id> 能取回文档 id', () => {
    expect(documentPagePath(ID)).toBe(`/documents/${ID}`)
    expect(documentIdFromPagePath(documentPagePath(ID))).toBe(ID)
    expect(documentIdFromPagePath(`/documents/${ID.toUpperCase()}`)).toBe(ID.toUpperCase())
  })

  it.each(['/documents', '/documents/', '/documents/abc', `/documents/${ID}/`, `/documents/${ID}.json`, `/documents/${ID}/x`, `/x/documents/${ID}`, `/DOCUMENTS/${ID}x`])('不是编辑器页：%s', (path) => {
    expect(documentIdFromPagePath(path)).toBeUndefined()
    expect(DOCUMENT_PAGE_PATTERN.test(path)).toBe(false)
  })
})
