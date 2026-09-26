// 公式 Worker 回报 IMAGE() 限制的安装结果（P4 设计 §3.6.7）：在同一个 Worker 上发平台自己的消息。
// Univer 的 RPC 只认数值型的 type，其他类型的消息直接忽略（rpc 的 rpc.service.ts:359、406-420）；
// 消息必须是对象，null 会让它解构时出错。所以 type 用字符串，消息总是对象
export const IMAGE_POLICY_MESSAGE_TYPE = 'nerve:image-policy'

export interface ImagePolicyReport {
  readonly type: typeof IMAGE_POLICY_MESSAGE_TYPE
  readonly ok: boolean
}

export function imagePolicyReport(ok: boolean): ImagePolicyReport {
  return { type: IMAGE_POLICY_MESSAGE_TYPE, ok }
}

/** 从 Worker 的消息里认出回报；RPC 的消息与其他消息返回 null */
export function readImagePolicyReport(data: unknown): ImagePolicyReport | null {
  if (typeof data !== 'object' || data === null)
    return null
  const { type, ok } = data as { type?: unknown, ok?: unknown }
  if (type !== IMAGE_POLICY_MESSAGE_TYPE || typeof ok !== 'boolean')
    return null
  return imagePolicyReport(ok)
}
