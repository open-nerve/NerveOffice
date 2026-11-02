import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'

/** 与普通文档共用 editor.html；地址只表达创建位置，不承载 CSV 正文。 */
export const CSV_CREATE_PAGE_PATH = '/documents/new/csv'
export const CSV_CREATE_PAGE_PATTERN = /^\/documents\/new\/csv$/u

export const csvCreateLocationSchema = z.strictObject({ spaceId: uuidSchema, folderId: uuidSchema.optional() })
export type CsvCreateLocation = z.infer<typeof csvCreateLocationSchema>

export function csvCreatePagePath(location: CsvCreateLocation): string {
  const valid = csvCreateLocationSchema.parse(location)
  return `${CSV_CREATE_PAGE_PATH}?spaceId=${valid.spaceId}${valid.folderId === undefined ? '' : `&folderId=${valid.folderId}`}`
}
