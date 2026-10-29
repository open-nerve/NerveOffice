// 首屏只保留响应对象与本机结果的内存关联；值由按需模块解析，不静态装入发件箱。
const permits = new WeakMap<object, unknown>()
type SessionFailure = { readonly kind: 'preserve' } | { readonly kind: 'disabled', readonly userId: string }
type FailureReporter = (facts: SessionFailure) => Promise<void>
const failures = new WeakMap<object, FailureReporter>()

export function rememberSessionPermit(response: object, permit: unknown, failed?: FailureReporter): void {
  if (permit === undefined)
    permits.delete(response)
  else
    permits.set(response, permit)
  if (typeof permit === 'object' && permit !== null && failed !== undefined)
    failures.set(permit, failed)
}

export function associatedSessionPermit(response: object): unknown {
  return permits.get(response)
}

/** 端口在按需资格模块发出原许可时绑定；调用同步登记，不把存储或队列装进首屏。 */
export function reportAssociatedSessionFailure(permit: unknown, facts: SessionFailure): Promise<void> | undefined {
  return typeof permit === 'object' && permit !== null ? failures.get(permit)?.(facts) : undefined
}
