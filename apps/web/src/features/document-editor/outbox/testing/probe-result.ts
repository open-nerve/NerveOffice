/** 错误只带名字与消息，测试探针也不把堆栈或正文散到调用边界。 */
export interface ProbeError {
  readonly name: string
  readonly message: string
}

export type Plain<T> = T extends { readonly kind: 'failed', readonly error: unknown } ? { readonly kind: 'failed', readonly error: ProbeError } : T

export function probeError(error: unknown): ProbeError {
  if (typeof error === 'object' && error !== null && 'name' in error && 'message' in error)
    return { name: String(error.name), message: String(error.message) }
  return { name: 'Error', message: String(error) }
}

export function plain<T extends { readonly kind: string }>(outcome: T): Plain<T> {
  if (outcome.kind === 'failed' && 'error' in outcome)
    return { ...outcome, error: probeError(outcome.error) } as Plain<T>
  return outcome as Plain<T>
}
