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
  /** 能访问这个资源，但没有这个操作的权限，例如只能查看的文档不能保存（没有任何权限时是 NOT_FOUND） */
  PERMISSION_DENIED: { status: 403, message: '没有执行这个操作的权限' },
  /** 修改密码时旧密码不对 */
  CURRENT_PASSWORD_INCORRECT: { status: 403, message: '当前密码不正确' },
  /** 资源不存在；没有读取权限时同样返回它，不暴露资源是否存在（规范 §4） */
  NOT_FOUND: { status: 404, message: '请求的资源不存在或无权访问' },
  /** 已有系统管理员，拒绝再次初始化（命令行初始化管理员） */
  ADMIN_ALREADY_INITIALIZED: { status: 409, message: '系统管理员已经初始化，不能重复执行' },
  /** 用户名已被别的账户使用（用户名不区分大小写） */
  USERNAME_TAKEN: { status: 409, message: '用户名已被占用' },
  /** 保存时的基准修订号不是当前修订号：别处保存了更新的版本。details 带当前修订号及其来源（revisionConflictDetailsSchema） */
  DOCUMENT_REVISION_CONFLICT: { status: 409, message: '别处保存了更新的版本，本次保存没有写入' },
  /** 同一个 requestId 已经用于另一个请求（负载不同，或者是别的操作） */
  REQUEST_ID_CONFLICT: { status: 409, message: '请求标识已被另一个请求使用' },
  /** 这个操作会让有效的系统管理员一个都不剩（取消或停用最后一个系统管理员） */
  LAST_ADMIN: { status: 409, message: '至少要保留一个有效的系统管理员' },
  /** 账户已停用，不能执行这个操作（例如签发重置链接） */
  ACCOUNT_DISABLED: { status: 409, message: '账户已停用' },
  /** 指定的账户不存在或已停用：添加成员、首个空间管理员、转移的目标（M2-P2）。同事目录里只有有效账户，两种情况不区分 */
  ACCOUNT_UNAVAILABLE: { status: 409, message: '这个账户不存在或已停用' },
  /** 只有停用的账户，才能转移它个人空间里的文档（M2-P2） */
  ACCOUNT_NOT_DISABLED: { status: 409, message: '账户仍然有效，只有停用的账户才能转移文档' },
  /** 团队空间的名称已被使用：不区分大小写，已归档的也算（M2-P2） */
  SPACE_NAME_TAKEN: { status: 409, message: '已有同名的团队空间' },
  /** 要添加的人已经是这个空间的成员；改角色用调整的接口（M2-P2） */
  ALREADY_MEMBER: { status: 409, message: '这个人已经是空间的成员' },
  /** 这个操作会让团队空间一个空间管理员都不剩（M2-P2） */
  LAST_SPACE_ADMIN: { status: 409, message: '团队空间至少要保留一个空间管理员' },
  /** 目标空间已归档：不能把文档转移进去（M2-P2） */
  SPACE_ARCHIVED: { status: 409, message: '空间已归档' },
  /** 新建或移动会让文件夹超过层数上限（M2-P4，FOLDER_MAX_DEPTH）：移动时整棵子树都要放得下 */
  FOLDER_DEPTH_EXCEEDED: { status: 409, message: '文件夹的层级超过上限' },
  /** 把文件夹移进它自己或它的子文件夹里（M2-P4）：目录会成环 */
  FOLDER_CYCLE: { status: 409, message: '不能把文件夹移动到它自己或它的子文件夹里' },
  /** 要转移的文档里，有的已经不在这个人的个人空间里（例如被别人转走了）：整批没有转移（M2-P2） */
  TRANSFER_CONFLICT: { status: 409, message: '有文档已经不在这个人的个人空间里，请刷新后重试' },
  /** 邀请或重置链接不能用。details 带原因：没有这个令牌、已过期、已使用、已作废（linkInvalidDetailsSchema） */
  LINK_INVALID: { status: 410, message: '链接无效或已失效' },
  /** 请求体超过上限，或 JSON 的嵌套层数、元素数量超过上限 */
  PAYLOAD_TOO_LARGE: { status: 413, message: '请求体超过上限' },
  /** 不支持的字符集或内容编码 */
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: '不支持的内容类型或编码' },
  /** 快照不合法：不是 UTF-8 的 JSON 对象、不是工作簿的结构、unitId 不是这份文档的、嵌套过深（M1 的基本校验） */
  SNAPSHOT_INVALID: { status: 422, message: '表格内容的格式不正确，无法保存' },
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
