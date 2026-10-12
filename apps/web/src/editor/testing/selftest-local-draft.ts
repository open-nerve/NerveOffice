// 测试构建的独立只读磁盘证据：不创建存储，不调用产品 Reader、采用或清理。
import type { StoredDraft } from '../../shared/outbox/draft-record.ts'

export async function readSelftestDraft(userId: string, documentId: string): Promise<StoredDraft | undefined> {
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
      const tx = db.transaction('drafts', 'readonly')
      const get: IDBRequest<unknown> = tx.objectStore('drafts').get([userId, documentId])
      tx.onabort = () => {
        db.close()
        reject(tx.error)
      }
      tx.oncomplete = () => {
        db.close()
        resolve(get.result as StoredDraft | undefined)
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
