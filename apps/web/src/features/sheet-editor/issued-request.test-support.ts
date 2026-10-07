// 测试用：这一页发出过的请求编辑的记号（issued-request.ts），存在内存里的"sessionStorage"上（每个标签页一份）
import type { IssuedRequestMarker } from './issued-request.ts'
import { issuedRequestMarker } from './issued-request.ts'

export interface MemoryIssuedRequest {
  readonly marker: IssuedRequestMarker
  /** 存储里的键与值（看写下了什么、模拟别的版本写的值） */
  readonly items: Map<string, string>
}

/** 一个标签页的记号：内存里的存储，接口与 sessionStorage 相同 */
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
