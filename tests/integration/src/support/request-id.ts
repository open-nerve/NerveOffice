// 请求标识（M2-P6 复核 C2）：服务端为每个请求生成，写在响应头 X-Request-Id 里，审计的 request_id 就是它。
// 客户端带来的 X-Request-Id 不进审计（只在日志里记成 clientRequestId），测试按响应头找审计记录。
import { REQUEST_ID_HEADER } from '@nerve-office/contracts'

export function requestIdOf(response: Response): string {
  const id = response.headers.get(REQUEST_ID_HEADER)
  if (id === null)
    throw new Error(`响应没有 ${REQUEST_ID_HEADER}（HTTP ${response.status}）`)
  return id
}
