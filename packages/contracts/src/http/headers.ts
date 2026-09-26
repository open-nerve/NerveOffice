/** 请求标识的请求头与响应头（规范 §7）：接受客户端或反向代理传来的合法值，否则由服务端生成。 */
export const REQUEST_ID_HEADER = 'x-request-id'

/** 状态变更请求（POST、PUT、PATCH、DELETE）带的 CSRF 令牌（P3 设计 §3.5）：取自登录与会话接口的响应。 */
export const CSRF_TOKEN_HEADER = 'x-csrf-token'
