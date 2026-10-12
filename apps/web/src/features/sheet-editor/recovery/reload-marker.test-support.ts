import type { ReloadStorage } from './reload-marker.ts'

export const RELOAD_KEY = { userId: '0199a2c4-1f2e-7a3b-8c4d-000000000001', documentId: '0199a2c4-1f2e-7a3b-8c4d-000000000002' }
export const OLD_INSTANCE = '0199a2c4-1f2e-4a3b-8c4d-000000000003'
export const RELOAD_WRITER = { writeEpoch: 7, writerId: '0199a2c4-1f2e-4a3b-8c4d-000000000005' }
/** 旧版记号只作迁移反例，生产代码不再写入。 */
export const RELOAD_MARKER = { ...RELOAD_KEY, ...RELOAD_WRITER, clientInstanceId: OLD_INSTANCE }

export const RELOAD_STORAGE_KEY = `nerve-office:reload:${RELOAD_KEY.userId}:${RELOAD_KEY.documentId}`

/** 每个标签页一份；复制时可克隆条目，之后互不影响。 */
export function reloadStorage(initial?: ReadonlyMap<string, string>): ReloadStorage & { readonly items: Map<string, string> } {
  const items = new Map(initial)
  return {
    items,
    get length() { return items.size },
    key: index => [...items.keys()][index] ?? null,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value) },
    removeItem: (key) => { items.delete(key) },
  }
}
