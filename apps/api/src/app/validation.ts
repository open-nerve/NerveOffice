import { AppError } from '../shared/errors/app-error.ts'

type IssuePath = ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>

/** Standard Schema 的校验问题（只用到路径）。 */
export interface ValidationIssue {
  readonly path?: IssuePath | undefined
}

/** 说明里最多列出几处，每处最长多少个字符：路径里可能有客户端给的键名（例如 record 的键），不能让它撑大响应（审查 A17）。 */
export const MAX_LISTED_PATHS = 5
export const MAX_PATH_LENGTH = 64

function formatPath(path: IssuePath | undefined): string {
  if (path === undefined || path.length === 0)
    return '（整体）'
  const text = path.map(segment => String(typeof segment === 'object' ? segment.key : segment)).join('.')
  return text.length > MAX_PATH_LENGTH ? `${text.slice(0, MAX_PATH_LENGTH)}…` : text
}

/** 校验管道的异常工厂：说明里列出不合法的字段路径，不回显取值（P2 设计 §3.5）。 */
export function validationError(issues: readonly ValidationIssue[]): AppError {
  const paths = [...new Set(issues.map(issue => formatPath(issue.path)))]
  const listed = paths.slice(0, MAX_LISTED_PATHS).join('、')
  const more = paths.length > MAX_LISTED_PATHS ? ` 等 ${paths.length} 处` : ''
  return new AppError('REQUEST_INVALID', `请求参数不合法：${listed}${more}`)
}
