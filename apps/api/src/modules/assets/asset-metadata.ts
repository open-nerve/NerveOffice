import type { AssetMimeType } from '@nerve-office/contracts'
import type { ProcessedImage } from './image-types.ts'

/** 仅供服务端授权编排，不作为 HTTP 响应；年龄与元数据来自同一个数据库快照。 */
export interface AssetMetadata extends Omit<ProcessedImage, 'data'> {
  readonly assetId: string
  readonly uploaderId: string
  readonly createdAt: Date
  readonly withinUploadWindow: boolean
}

export interface AssetImage {
  readonly data: Uint8Array
  readonly mimeType: AssetMimeType
}
