import type { ProcessedImage } from './image-types.ts'

declare const objectKeyBrand: unique symbol
export type AssetObjectKey = string & { readonly [objectKeyBrand]: true }

/** 只有服务端验证后的 SHA-256 能变成对象键；不接受原文件名或客户端路径。 */
export function assetObjectKey(sha256: string): AssetObjectKey {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
    throw new Error('资源摘要不符合对象键格式')
  return `objects/${sha256.slice(0, 2)}/${sha256}` as AssetObjectKey
}

export interface StoredImageExpectation {
  readonly sha256: string
  readonly bytes: number
}

/** 只追加完整对象；P1 不提供删除正式对象的能力。read 调用方必须先完成业务授权。 */
export interface StorageAdapter {
  initialize: () => Promise<void>
  publish: (image: ProcessedImage) => Promise<AssetObjectKey>
  read: (key: AssetObjectKey, expected: StoredImageExpectation) => Promise<Uint8Array>
}

export type StorageOperation = 'initialize' | 'publish' | 'read'
export type StorageFailure = 'invalid-key' | 'unsafe-path' | 'integrity' | 'io' | 'not-initialized'

/** 原生 IO 错误可能含绝对路径；只保留可记录的阶段与分类，不附原始 cause。 */
export class AssetStorageError extends Error {
  override readonly name = 'AssetStorageError'

  constructor(readonly operation: StorageOperation, readonly reason: StorageFailure) {
    super(`图片存储失败：${operation}/${reason}`)
  }
}
