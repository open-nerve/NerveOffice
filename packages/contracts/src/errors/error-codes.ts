/**
 * 错误码登记表（规范 §2.3、§4，ADR-006）：每个错误码对应固定的 HTTP 状态与默认说明。
 * - 错误码是这个对象字面量的键，重复的键由 TypeScript 与 ESLint（no-dupe-keys）拦下；
 * - 发布后语义不变；不再使用的错误码移入 RETIRED_ERROR_CODES，编号不复用；
 * - 默认说明面向用户，不含内部细节。
 */
export const ERROR_CODES = {
  /** 输入不合法：校验失败、请求体不是合法的 JSON */
  REQUEST_INVALID: { status: 400, message: '请求的格式或参数不合法' },
  /** 没有登录 */
  UNAUTHENTICATED: { status: 401, message: '请先登录' },
  /** 带着会话 Cookie，但会话已过期或被撤销：界面提示登录已过期，而不是当作从未登录 */
  SESSION_EXPIRED: { status: 401, message: '登录已过期，请重新登录' },
  /** 用户名或密码错误：两种情况不区分，不暴露账户是否存在 */
  INVALID_CREDENTIALS: { status: 401, message: '用户名或密码错误' },
  /** 状态变更请求缺少或带错了 CSRF 令牌 */
  CSRF_TOKEN_INVALID: { status: 403, message: '请求已失效，请刷新页面后重试' },
  /** 状态变更请求的 Origin 不是本站 */
  ORIGIN_NOT_ALLOWED: { status: 403, message: '请求来源不被允许' },
  /** 资源不存在；没有读取权限时同样返回它，不暴露资源是否存在（规范 §4） */
  NOT_FOUND: { status: 404, message: '请求的资源不存在或无权访问' },
  /** 已有系统管理员，拒绝再次初始化（命令行初始化管理员） */
  ADMIN_ALREADY_INITIALIZED: { status: 409, message: '系统管理员已经初始化，不能重复执行' },
  /** 请求体超过上限，或 JSON 的嵌套层数、元素数量超过上限 */
  PAYLOAD_TOO_LARGE: { status: 413, message: '请求体超过上限' },
  /** 不支持的字符集或内容编码 */
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: '不支持的内容类型或编码' },
  /** 登录失败次数过多，暂时锁定；响应带 Retry-After */
  TOO_MANY_ATTEMPTS: { status: 429, message: '尝试次数过多，请稍后再试' },
  /** 意外错误：对外只返回通用说明与请求标识，细节只写进日志 */
  INTERNAL_ERROR: { status: 500, message: '服务器内部错误，请稍后重试' },
  /** 未就绪、正在退出 */
  SERVICE_UNAVAILABLE: { status: 503, message: '服务暂时不可用，请稍后重试' },
} as const satisfies Record<string, { readonly status: number, readonly message: string }>

export type ErrorCode = keyof typeof ERROR_CODES

/** 已经不再使用的错误码：不得重新启用，也不得用于新的含义。 */
export const RETIRED_ERROR_CODES: readonly string[] = []

export function errorStatus(code: ErrorCode): number {
  return ERROR_CODES[code].status
}
