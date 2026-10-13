// 首屏只保留响应对象与本机结果的内存关联；值由按需模块解析，不静态装入发件箱。
const permits = new WeakMap<object, unknown>()

export function rememberSessionPermit(response: object, permit: unknown): void {
  if (permit === undefined)
    permits.delete(response)
  else
    permits.set(response, permit)
}

export function associatedSessionPermit(response: object): unknown {
  return permits.get(response)
}
