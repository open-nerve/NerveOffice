import { ApiError } from '../../shared/api/api-errors.ts'
import { AssetInputError } from '../../shared/assets/asset-api.ts'
import { ImageFileInputError } from './image-input-policy.ts'

export type ImageUploadFailureReason = 'size' | 'type' | 'invalid' | 'quota'

/** 只将已知类型和有限状态映射为原因；原始 message/details 不进入用户提示。 */
export function classifyImageUploadFailure(error: unknown): ImageUploadFailureReason | undefined {
  if (error instanceof ImageFileInputError)
    return error.reason
  if (error instanceof AssetInputError && error.reason !== 'address')
    return error.reason
  if (!(error instanceof ApiError))
    return undefined
  // 反向代理可能没有协议错误码，可信 HTTP 状态仍能表明大小或类型拒绝。
  if (error.status === 413)
    return 'size'
  if (error.status === 415)
    return 'type'
  if (error.status === 422 && error.code === 'ASSET_INVALID')
    return 'invalid'
  if (error.status === 409 && error.code === 'ASSET_QUOTA_EXCEEDED')
    return 'quota'
  return undefined
}
