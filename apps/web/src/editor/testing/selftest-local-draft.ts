// 测试构建的独立只读磁盘证据：不创建存储，不调用产品 Reader、采用或清理。
import type { StoredDraft, WriterRecord } from '../../shared/outbox/draft-record.ts'

export async function readSelftestDraft(userId: string, documentId: string): Promise<StoredDraft | undefined> {
  return readSelftestRecord<StoredDraft>('drafts', userId, documentId)
}

export async function readSelftestWriter(userId: string, documentId: string): Promise<WriterRecord | undefined> {
  return readSelftestRecord<WriterRecord>('writers', userId, documentId)
}

async function readSelftestRecord<T>(store: string, userId: string, documentId: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('nerve-office-outbox')
    let absent = false
    open.onupgradeneeded = () => {
      absent = true
      open.transaction?.abort()
    }
    open.onerror = () => absent ? resolve(undefined) : reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains(store)) {
        db.close()
        reject(new Error('本轮存储缺少指定的只读对象仓库'))
        return
      }
      const tx = db.transaction(store, 'readonly')
      const get: IDBRequest<unknown> = tx.objectStore(store).get([userId, documentId])
      tx.onabort = () => {
        db.close()
        reject(tx.error)
      }
      tx.oncomplete = () => {
        db.close()
        resolve(get.result as T | undefined)
      }
    }
  })
}

/** 包含全部原元数据、IV 与密文；报告仅保留摘要，不保留正文或密钥。 */
export async function selftestDraftHash(draft: StoredDraft): Promise<string> {
  const { iv, ciphertext, ...meta } = draft
  const bytes = new TextEncoder().encode(JSON.stringify([meta, Array.from(iv), Array.from(ciphertext)]))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
