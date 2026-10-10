// 发件箱跨边界交出的错误（M4-P1 设计 §3.5）：只带名字与消息——结构化克隆得了（跨 Worker 原样传递），不带堆栈，也就不会带出内容。
// 写入管道、OPFS 的镜像与 Worker 的协议共用。发件箱 Worker 也引用这个文件：不引用 zod，不依赖 DOM

/** 未知的错误：只带名字与消息 */
export interface FailureDescription {
  readonly name: string
  readonly message: string
}

/** 未知的错误折成名字与消息：Error 与 DOMException 照原样（按形状认，不用 instanceof：别的 realm 的错误），别的东西转成文字 */
export function describeFailure(error: unknown): FailureDescription {
  if (typeof error === 'object' && error !== null && 'name' in error && 'message' in error && typeof error.name === 'string' && typeof error.message === 'string')
    return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}
