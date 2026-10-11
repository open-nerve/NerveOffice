import type { DraftKey } from '../../../shared/outbox/draft-record.ts'
import type { WriterIdentity } from '../../../shared/outbox/writer-fence.ts'
import type { MarkerStorage } from '../pending-save-marker.ts'
import { uuidSchema } from '@nerve-office/contracts'
import { z } from 'zod'

/** 自动重载的候选身份；不含令牌、密钥、正文或租约有效期。 */
export interface ReloadMarker extends DraftKey, WriterIdentity {
  readonly clientInstanceId: string
}

export interface ReloadMarkerPort {
  readonly read: () => ReloadMarker | undefined
  /** 仅实际写成时交回规范身份，调用者据此绑定后续清理。 */
  readonly write: (identity: WriterIdentity & { readonly clientInstanceId: string }) => ReloadMarker | undefined
  /** 给出 expected 时只删本轮观察/写入的身份；普通导航同步失效可不带条件。 */
  readonly clear: (expected?: ReloadMarker) => void
}

const RELOAD_PREFIX = 'nerve-office:reload:'

export function reloadMarkerKey(key: DraftKey): string {
  return `${RELOAD_PREFIX}${key.userId.toLowerCase()}:${key.documentId.toLowerCase()}`
}

export type ReloadStorage = MarkerStorage & Pick<Storage, 'length' | 'key'>

/** 普通导航同步丢弃本标签页继承的资格；不能等会话或正文请求成功后才清理。 */
export function clearInheritedReloadMarkers(storage: () => ReloadStorage): void {
  try {
    const target = storage()
    for (let index = target.length - 1; index >= 0; index--) {
      const key = target.key(index)
      if (key?.startsWith(RELOAD_PREFIX))
        target.removeItem(key)
    }
  }
  catch {
    // 存储不可访问时本次自动资格同样不可用，不影响普通阅读。
  }
}

const storedSchema = z.strictObject({
  v: z.literal(1),
  userId: uuidSchema,
  documentId: uuidSchema,
  clientInstanceId: uuidSchema,
  writeEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  writerId: uuidSchema,
})

/** sessionStorage 本身的访问也可能被禁止；失败只关闭自动资格。 */
export function reloadMarker(input: DraftKey, options: { readonly storage: () => MarkerStorage }): ReloadMarkerPort {
  const key = { userId: input.userId.toLowerCase(), documentId: input.documentId.toLowerCase() }
  const storageKey = reloadMarkerKey(key)
  function read(): ReloadMarker | undefined {
    try {
      const raw = options.storage().getItem(storageKey)
      if (raw === null)
        return undefined
      const parsed = storedSchema.safeParse(JSON.parse(raw))
      if (!parsed.success || parsed.data.userId !== key.userId || parsed.data.documentId !== key.documentId)
        return undefined
      const { v: _version, ...identity } = parsed.data
      return identity
    }
    catch {
      return undefined
    }
  }
  return {
    read,
    write: ({ clientInstanceId, writeEpoch, writerId }) => {
      const parsed = storedSchema.safeParse({ v: 1, userId: key.userId, documentId: key.documentId, clientInstanceId, writeEpoch, writerId })
      if (!parsed.success)
        return
      try {
        options.storage().setItem(storageKey, JSON.stringify(parsed.data))
        const { v: _version, ...identity } = parsed.data
        return identity
      }
      catch {
        // 没写成就不能靠这次身份自动恢复；原件仍可经显式操作找回。
      }
    },
    clear: (expected) => {
      try {
        if (expected !== undefined) {
          const current = read()
          if (current === undefined || current.userId !== expected.userId || current.documentId !== expected.documentId
            || current.clientInstanceId !== expected.clientInstanceId || current.writeEpoch !== expected.writeEpoch || current.writerId !== expected.writerId) {
            return
          }
        }
        options.storage().removeItem(storageKey)
      }
      catch {
        // 与读写一样，不把浏览器存储异常抛到页面。
      }
    },
  }
}
