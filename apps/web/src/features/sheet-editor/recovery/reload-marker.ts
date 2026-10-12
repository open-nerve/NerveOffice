import type { MarkerStorage } from '../pending-save-marker.ts'

const RELOAD_PREFIX = 'nerve-office:reload:'

export type ReloadStorage = MarkerStorage & Pick<Storage, 'length' | 'key'>

/** 迁移旧版本的会话记号；所有新 Document 都清理，不读取内容、不触碰持久草稿。 */
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
    // 清理失败不影响阅读；页面身份从不依赖这些旧记号。
  }
}
