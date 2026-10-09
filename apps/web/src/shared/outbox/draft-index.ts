// 列表的标记（M4-P1 设计 §3.4.7，M4 总设计 §6.7）：某人在这台设备上有草稿的文档 id。只读键（getAllKeys），不读值、不要密钥、
// 不访问服务端。平台页面（文档列表、搜索结果）唯一可以引用的发件箱文件（P4 按需加载它）：只引用 database.ts，不引用 zod 与契约。
// 库还不存在时不建它；库打不开、读不出都交回空集合——标记只是提示，不挡住列表
import { browserIndexedDb, DRAFTS_STORE, openExistingOutboxDatabase, userKeyRange } from './database.ts'

/** 打开库最多等多久（毫秒）：别的标签页正在升级时打开要等，列表不为它多等 */
const OPEN_TIMEOUT_MS = 3000

/** userId 在这台设备上有草稿的文档 id */
export async function draftDocumentIds(userId: string): Promise<ReadonlySet<string>> {
  const connection = await openExistingOutboxDatabase({ factory: browserIndexedDb, timeoutMs: OPEN_TIMEOUT_MS })
  if (connection === undefined)
    return new Set()
  try {
    if (!connection.db.objectStoreNames.contains(DRAFTS_STORE))
      return new Set()
    const keys = await new Promise<readonly IDBValidKey[]>((resolve, reject) => {
      const request = connection.db.transaction(DRAFTS_STORE, 'readonly').objectStore(DRAFTS_STORE).getAllKeys(userKeyRange(userId))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new DOMException('读不出草稿的键', 'UnknownError'))
    })
    const ids = new Set<string>()
    for (const key of keys) {
      if (Array.isArray(key) && typeof key[1] === 'string')
        ids.add(key[1])
    }
    return ids
  }
  catch {
    // 读的时候连接被断开、库被删：没有标记
    return new Set()
  }
  finally {
    connection.close()
  }
}
