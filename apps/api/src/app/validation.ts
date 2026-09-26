import { AppError } from '../shared/errors/app-error.ts'

type IssuePath = ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>

/** Standard Schema 的校验问题（只用到路径）。 */
export interface ValidationIssue {
  readonly path?: IssuePath | undefined
}

function formatPath(path: IssuePath | undefined): string {
  if (path === undefined || path.length === 0)
    return '（整体）'
  return path.map(segment => String(typeof segment === 'object' ? segment.key : segment)).join('.')
}

/** 校验管道的异常工厂：说明里列出不合法的字段路径，不回显取值（P2 设计 §3.5）。 */
export function validationError(issues: readonly ValidationIssue[]): AppError {
  const paths = [...new Set(issues.map(issue => formatPath(issue.path)))]
  return new AppError('REQUEST_INVALID', `请求参数不合法：${paths.join('、')}`)
}
