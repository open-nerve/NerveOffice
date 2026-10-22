import type { ProcessedImage } from './image-types.ts'

export const ASSET_STORAGE = Symbol('ASSET_STORAGE')

declare const objectKeyBrand: unique symbol
export type AssetObjectKey = string & { readonly [objectKeyBrand]: true }

/** 只有服务端验证后的 SHA-256 能变成对象键；不接受原文件名或客户端路径。 */
export function assetObjectKey(sha256: string, generation?: string | null): AssetObjectKey {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
    throw new Error('资源摘要不符合对象键格式')
  if (generation != null && (typeof generation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generation)))
    throw new Error('资源代次不符合对象键格式')
  return `objects/${sha256.slice(0, 2)}/${sha256}${generation == null ? '' : `.${generation}`}` as AssetObjectKey
}

/** 只接受该摘要的旧路径或带规范代次的路径；不得把品牌类型当作运行时校验。 */
export function parseAssetObjectKey(key: string, sha256: string): AssetObjectKey {
  const legacy = assetObjectKey(sha256)
  if (key === legacy)
    return legacy
  if (typeof key !== 'string' || !key.startsWith(`${legacy}.`))
    throw new Error('资源路径与摘要不一致')
  return assetObjectKey(sha256, key.slice(legacy.length + 1))
}

export interface StoredImageExpectation {
  readonly sha256: string
  readonly bytes: number
}

/** 发布不覆盖；退休只消费已持久化的精确代次回执，留下永久空标记。read 必须先完成业务授权。 */
export interface StorageAdapter {
  initialize: () => Promise<void>
  publish: (image: ProcessedImage, key: AssetObjectKey) => Promise<AssetObjectKey>
  read: (key: AssetObjectKey, expected: StoredImageExpectation) => Promise<Uint8Array>
  retire: (key: AssetObjectKey, expected: StoredImageExpectation) => Promise<void>
}

export type StorageOperation = 'initialize' | 'publish' | 'read' | 'retire'
export type StorageFailure = 'invalid-key' | 'unsafe-path' | 'integrity' | 'io' | 'not-initialized'

/** 原生 IO 错误可能含绝对路径；只保留可记录的阶段与分类，不附原始 cause。 */
export class AssetStorageError extends Error {
  override readonly name = 'AssetStorageError'

  constructor(readonly operation: StorageOperation, readonly reason: StorageFailure) {
    super(`图片存储失败：${operation}/${reason}`)
  }
}
