// 测试用：当前 Document 内存意图，以及只用于旧版本迁移反例的 sessionStorage。
import type { IssuedRequestMarker } from './issued-request.ts'
import { issuedRequestMarker } from './issued-request.ts'

export interface MemoryIssuedRequest {
  readonly marker: IssuedRequestMarker
  /** 遗留存储里的键与值（当前意图不会写入这里） */
  readonly items: Map<string, string>
}

/** 一个新 Document 的内存意图；假存储用于旧记号清理 */
export function memoryIssuedRequest(documentId: string): MemoryIssuedRequest {
  const items = new Map<string, string>()
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
    removeItem: (key: string) => {
      items.delete(key)
    },
  }
  return { marker: issuedRequestMarker(documentId, { storage: () => storage }), items }
}
