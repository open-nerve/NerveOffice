import type { CsvCreateLocation } from './csv-create-page.ts'
import { CSV_CREATE_PAGE_PATTERN, csvCreateLocationSchema } from './csv-create-page.ts'

/** 只在创建页解析用户地址；平台生成链接无需下载查询参数解析逻辑。 */
export function csvCreateLocation(pathname: string, parameters: Iterable<readonly [string, string]>): CsvCreateLocation | undefined {
  if (!CSV_CREATE_PAGE_PATTERN.test(pathname))
    return undefined
  const query = [...parameters]
  const keys = query.map(([key]) => key)
  if (new Set(keys).size !== keys.length)
    return undefined
  const parsed = csvCreateLocationSchema.safeParse(Object.fromEntries(query))
  return parsed.success ? parsed.data : undefined
}
