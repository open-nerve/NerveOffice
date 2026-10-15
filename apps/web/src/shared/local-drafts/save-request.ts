import type { ContentFormat } from '../outbox/draft-record.ts'

export interface SaveRequest {
  readonly baseRevision: number
  readonly requestId: string
  readonly clientInstanceId: string
  /** 来源中这份字节的真实内容序号，与编辑器修改计数分开。 */
  readonly localSeq: number
  readonly format: ContentFormat
  /** "公式待更新"（M3-P3 设计 §3.8）：捕获时公式还没收齐，服务端记在文档上 */
  readonly formulasPending: boolean
}
