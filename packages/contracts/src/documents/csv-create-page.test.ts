import { describe, expect, it } from 'vitest'
import { csvCreateLocation } from './csv-create-location.ts'
import { CSV_CREATE_PAGE_PATH, CSV_CREATE_PAGE_PATTERN, csvCreatePagePath } from './csv-create-page.ts'
import { documentIdFromPagePath, documentPagePath } from './document-page.ts'

const SPACE = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const FOLDER = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'

describe('从 CSV 新建的编辑器页地址', () => {
  it.each([{ spaceId: SPACE }, { spaceId: SPACE, folderId: FOLDER }])('目标位置往返，地址不包含正文', (location) => {
    expect(csvCreatePagePath(location)).toBe(`/documents/new/csv?spaceId=${SPACE}${'folderId' in location ? `&folderId=${FOLDER}` : ''}`)
    expect(CSV_CREATE_PAGE_PATH).toBe('/documents/new/csv')
    expect(CSV_CREATE_PAGE_PATTERN.test(CSV_CREATE_PAGE_PATH)).toBe(true)
    expect(csvCreateLocation(CSV_CREATE_PAGE_PATH, Object.entries(location))).toEqual(location)
    expect(documentIdFromPagePath(CSV_CREATE_PAGE_PATH)).toBeUndefined()
  })

  it('UUID 大写正规化；普通文档仍是原路由', () => {
    expect(csvCreateLocation(CSV_CREATE_PAGE_PATH, [['spaceId', SPACE.toUpperCase()], ['folderId', FOLDER.toUpperCase()]])).toEqual({ spaceId: SPACE, folderId: FOLDER })
    expect(csvCreateLocation(documentPagePath(SPACE), [['spaceId', SPACE]])).toBeUndefined()
    expect(documentIdFromPagePath(documentPagePath(SPACE))).toBe(SPACE)
  })

  it.each(['', '/documents/new/csv/', '/documents/new/csv.json', '/documents/new/csv/x', '/api/documents/new/csv'])('错误路径拒绝：%s', (path) => {
    expect(CSV_CREATE_PAGE_PATTERN.test(path)).toBe(false)
    expect(csvCreateLocation(path, [['spaceId', SPACE]])).toBeUndefined()
  })

  const invalid: [string, string][][] = [[], [['spaceId', 'bad']], [['folderId', FOLDER]], [['spaceId', SPACE], ['folderId', '']], [['spaceId', SPACE], ['folderId', 'bad']], [['spaceId', SPACE], ['spaceId', SPACE]], [['spaceId', SPACE], ['folderId', FOLDER], ['folderId', FOLDER]], [['spaceId', SPACE], ['csv', 'secret']], [['spaceId', SPACE], ['returnTo', 'https://elsewhere.test']]]
  for (const parameters of invalid) {
    it(`缺少、重复、未知或非法参数拒绝：${JSON.stringify(parameters)}`, () => {
      expect(csvCreateLocation(CSV_CREATE_PAGE_PATH, parameters)).toBeUndefined()
    })
  }

  it('生成链接也拒绝非法 UUID，不把任意输入拼入地址', () => {
    expect(() => csvCreatePagePath({ spaceId: '../outside' })).toThrow()
    expect(() => csvCreatePagePath({ spaceId: SPACE, folderId: 'bad' })).toThrow()
  })
})
