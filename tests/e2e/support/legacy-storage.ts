import type { Page } from '@playwright/test'

export const LEGACY_SDK_DB = 'UniverLocalStorage'
export const UNRELATED_DB = 'nerve-e2e-unrelated'

/** 旧版本真实数据库；种一项非文档偏好并关闭连接，不伪造删除结果。 */
export async function seedLegacyDatabase(page: Page, name = LEGACY_SDK_DB): Promise<void> {
  await page.evaluate(async (name) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name)
      open.onupgradeneeded = () => open.result.createObjectStore('kv')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put('unchanged', 'legacy-before')
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onabort = () => {
          db.close()
          reject(tx.error)
        }
      }
    })
  }, name)
}

/** 不存在时取消创建，观察不会留下新库。 */
export async function legacyDatabaseKeys(page: Page, name = LEGACY_SDK_DB): Promise<readonly string[] | null> {
  return page.evaluate(async (name) => {
    return new Promise<string[] | null>((resolve, reject) => {
      const open = indexedDB.open(name)
      let absent = false
      open.onupgradeneeded = () => {
        absent = true
        open.transaction?.abort()
      }
      open.onerror = () => absent ? resolve(null) : reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('kv', 'readonly')
        const keys = tx.objectStore('kv').getAllKeys()
        tx.oncomplete = () => {
          db.close()
          resolve(keys.result.map(String))
        }
        tx.onabort = () => {
          db.close()
          reject(tx.error)
        }
      }
    })
  }, name)
}

export async function seedLegacyKeys(page: Page, userId: string): Promise<void> {
  await page.evaluate((userId) => {
    const keys = [
      `nerve-office:pending-save:${userId}:original`,
      'nerve-office:pending-save:other-user:original',
      'nerve-office:pending-save:old-document',
      'nerve-office:reload:old',
      'nerve-office:edit-request:old',
      'UniverLocalStorage/legacy',
      'univer-mobile-recent-formula-functions',
      'unrelated-key',
    ]
    for (const key of keys) {
      localStorage.setItem(key, 'unchanged')
      // SDK 偏好从不在 sessionStorage；只种实际历史记号。
      if (key.startsWith('nerve-office:'))
        sessionStorage.setItem(key, 'unchanged')
    }
  }, userId)
}

export async function remainingLegacyKeys(page: Page) {
  return page.evaluate(() => {
    const relevant = (key: string) => key.startsWith('nerve-office:pending-save:') || key.startsWith('nerve-office:reload:')
      || key.startsWith('nerve-office:edit-request:') || key.startsWith('UniverLocalStorage/') || key === 'univer-mobile-recent-formula-functions' || key === 'unrelated-key'
    return { local: Object.keys(localStorage).filter(relevant).sort(), session: Object.keys(sessionStorage).filter(relevant).sort() }
  })
}

/** 模拟仍开着的旧版页面：保留真实连接，不在 versionchange 时自动关闭。关闭页面即释放。 */
export async function holdLegacyDatabase(page: Page): Promise<void> {
  await page.goto('/api/health/ready')
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('UniverLocalStorage')
      open.onupgradeneeded = () => open.result.createObjectStore('kv')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const observation = { db: open.result, versionchange: false }
        Object.assign(window, { __legacyStorageHeld: observation })
        open.result.onversionchange = () => {
          observation.versionchange = true
        }
        resolve()
      }
    })
  })
}

export async function sawLegacyDeletion(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { readonly __legacyStorageHeld: { readonly versionchange: boolean } }).__legacyStorageHeld.versionchange)
}
