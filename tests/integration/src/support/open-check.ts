// 打开自检失败的上报（M3-P4 设计 §3.13）：集成测试扮演现在的页面——版本四项取 client-format.ts 的 CURRENT_CLIENT。
import type { LoggedIn } from './session-client.ts'
import { CURRENT_CLIENT } from './client-format.ts'
import { asUser } from './session-client.ts'

/** 一次合法的上报：只读打开的文档，筛选的数据解析抛错之后变空 */
export function openCheckReport(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    revision: 1,
    access: 'read',
    trigger: 'open',
    failures: [
      { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' },
      { kind: 'resource-emptied', resource: 'SHEET_FILTER_PLUGIN' },
    ],
    ...CURRENT_CLIENT,
    ...overrides,
  }
}

export function openCheckPath(documentId: string): string {
  return `/api/documents/${documentId}/open-check-failures`
}

/** 以这个人上报（默认是合法的上报） */
export async function postOpenCheckReport(baseUrl: string, user: LoggedIn, documentId: string, body: unknown = openCheckReport()): Promise<Response> {
  return asUser(baseUrl, user, openCheckPath(documentId), { method: 'POST', body })
}
