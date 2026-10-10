// 请求层的错误类型；独立于请求生命周期，原公开导出仍由 client.ts 保留。
export interface ApiErrorDetails {
  readonly requestId?: string
  /** 响应头 Retry-After（秒）：429，与服务繁忙的 503（快照检查池满、每个账户 2 份、数据库繁忙，M3-P3）；自动保存按它退避（M3-P4） */
  readonly retryAfterSeconds?: number
  /** 错误响应的 details：结构按错误码约定，使用方按错误码用 contracts 里的结构再校验（ADR-006） */
  readonly details?: Readonly<Record<string, unknown>>
  /** 服务端回答的时刻（响应头 Date，毫秒时间戳，精确到秒） */
  readonly serverTime?: number
}

/**
 * 服务端按约定返回的错误。code 是错误码：可能是前端还不认识的（服务端比前端新），
 * 为 UNKNOWN 时表示响应不是约定的格式（例如反向代理的错误页）。
 */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly status: number
  readonly code: string
  readonly requestId: string | undefined
  readonly retryAfterSeconds: number | undefined
  readonly details: Readonly<Record<string, unknown>> | undefined
  /**
   * 服务端回答这次请求的时刻（响应头 Date；没有或读不出来时为 undefined）。details 里服务端的时间（例如别人的最后活动时间）
   * 拿它来比，算出"多久之前"，不拿浏览器的时钟去比：浏览器的时钟可能不准（M3 总设计 §2.1）
   */
  readonly serverTime: number | undefined

  constructor(status: number, code: string, message: string, details: ApiErrorDetails = {}) {
    super(message)
    this.status = status
    this.code = code
    this.requestId = details.requestId
    this.retryAfterSeconds = details.retryAfterSeconds
    this.details = details.details
    this.serverTime = details.serverTime
  }
}

/** 请求没能到达服务端，或者没有收到响应（断网、服务不可达）。 */
export class NetworkError extends Error {
  override readonly name: string = 'NetworkError'
}

/** 成功的响应与契约的结构不一致：前后端版本不一致，或者服务端的缺陷。不渲染出错的数据。 */
export class ResponseFormatError extends Error {
  override readonly name = 'ResponseFormatError'
}

/** 应用时限已到；请求可能已经提交，仍是网络异常与结果未知，不能当作确定拒绝。 */
export class RequestTimeoutError extends NetworkError {
  override readonly name = 'RequestTimeoutError'
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super('网络请求超过了时限')
    this.timeoutMs = timeoutMs
  }
}
