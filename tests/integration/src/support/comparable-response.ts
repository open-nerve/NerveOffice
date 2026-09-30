// 响应里可以比较的部分（M2-P6 复核 S2）："看不到"与"不存在"的响应要完全一致：状态码、错误体（去掉每个请求都不同的请求标识）、
// 非易变的响应头（名称与取值）。权限矩阵的 404 格与"看不到与不存在"的逐条比较都用它。

/** 每个请求都不同的响应头：日期、请求标识、按正文算出的 ETag、会话的 Cookie、连接的保持 */
const VOLATILE_HEADERS: ReadonlySet<string> = new Set(['date', 'x-request-id', 'etag', 'set-cookie', 'keep-alive', 'connection'])

export interface ComparableResponse {
  readonly status: number
  /** JSON 正文；错误体去掉了 error.requestId；空的正文为 undefined */
  readonly body: unknown
  /** 非易变的响应头 */
  readonly headers: Readonly<Record<string, string>>
}

/** 错误体去掉请求标识，其余（code、message、details 等）原样 */
function withoutRequestId(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null) {
    const { requestId: _requestId, ...error } = body.error as Record<string, unknown>
    return { ...body, error }
  }
  return body
}

/** 读完响应的正文，取出可以比较的部分 */
export async function comparableOf(response: Response): Promise<ComparableResponse> {
  const text = await response.text()
  const headers = Object.fromEntries([...response.headers.entries()].filter(([name]) => !VOLATILE_HEADERS.has(name)))
  return { status: response.status, body: text === '' ? undefined : withoutRequestId(JSON.parse(text)), headers }
}
