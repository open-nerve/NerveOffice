import type { Page } from '@playwright/test'
import type { DraftKey } from './outbox-probe.ts'

/** 只读真实 OPFS 槽位，返回摘要；不输出密文或正文。 */
export async function mirrorDigests(page: Page, key: DraftKey): Promise<readonly string[]> {
  return page.evaluate(async (key) => {
    try {
      const root = await navigator.storage.getDirectory()
      const top = await root.getDirectoryHandle('nerve-office-outbox')
      const user = await top.getDirectoryHandle(key.userId)
      const directory = await user.getDirectoryHandle(key.documentId)
      const values: string[] = []
      for (const name of ['a', 'b']) {
        try {
          const file = await (await directory.getFileHandle(name)).getFile()
          const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
          values.push(`${name}:${file.size}:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`)
        }
        catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'NotFoundError')
            throw error
        }
      }
      return values
    }
    catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError')
        return []
      throw error
    }
  }, key)
}

/** 仅当前测试页面的目录删除失败；解除后继续调用真实 OPFS，不伪造清理结果。 */
export async function failMirrorRemoval(page: Page, onlyName?: string): Promise<() => Promise<void>> {
  await page.evaluate(({ onlyName }) => {
    const original: typeof FileSystemDirectoryHandle.prototype.removeEntry = Reflect.get(FileSystemDirectoryHandle.prototype, 'removeEntry')
    Object.assign(window, { __cleanupMirrorBlocked: true })
    FileSystemDirectoryHandle.prototype.removeEntry = async function (...args) {
      if ((onlyName === undefined || args[0] === onlyName) && (window as unknown as { __cleanupMirrorBlocked: boolean }).__cleanupMirrorBlocked)
        throw new DOMException('测试退出时目录正在占用', 'NoModificationAllowedError')
      return Reflect.apply(original, this, args)
    }
  }, { onlyName })
  return async () => page.evaluate(() => {
    (window as unknown as { __cleanupMirrorBlocked: boolean }).__cleanupMirrorBlocked = false
  })
}

/** 已有真实镜像之后才安装：只让当前 Document 根目录读取失败，其他页仍可独立核对磁盘。 */
export async function failMirrorRoot(page: Page, name: 'UnknownError' | 'SecurityError'): Promise<() => Promise<void>> {
  await page.evaluate((name) => {
    const prototype = Object.getPrototypeOf(navigator.storage) as StorageManager
    const original: typeof navigator.storage.getDirectory = Reflect.get(prototype, 'getDirectory')
    Object.assign(window, { __cleanupMirrorRootFailed: true })
    prototype.getDirectory = async function () {
      if ((window as unknown as { __cleanupMirrorRootFailed: boolean }).__cleanupMirrorRootFailed)
        throw new DOMException('测试读取已有镜像根目录失败', name)
      return Reflect.apply(original, this, [])
    }
  }, name)
  const observed = await page.evaluate(async () => {
    try {
      await navigator.storage.getDirectory()
      return 'opened'
    }
    catch (error) {
      return error instanceof DOMException ? error.name : 'other-error'
    }
  })
  if (observed !== name)
    throw new Error(`根目录故障未生效：预期 ${name}，实际 ${observed}`)
  return async () => page.evaluate(() => {
    (window as unknown as { __cleanupMirrorRootFailed: boolean }).__cleanupMirrorRootFailed = false
  })
}

/** 延迟前台 beginUser 的返回，但真实存储锁已经释放，让后台实际清完同一次原许可。 */
export async function pauseLogoutAfterBegin(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const original = navigator.locks.request.bind(navigator.locks)
    const gate = { paused: false, committedKind: undefined as string | undefined, resume: (): void => {} }
    Object.assign(window, { __logoutAfterBegin: gate })
    let armed = true
    navigator.locks.request = async function (...args: unknown[]) {
      const result: unknown = await Reflect.apply(original, navigator.locks, args)
      if (armed && args[0] === 'nerve-office-outbox-operation' && result !== null && typeof result === 'object' && Reflect.get(result, 'kind') === 'clearing') {
        armed = false
        // 记录已提交事务的真实返回值；存储锁已释放，同页维护此后也可能立刻清完。
        gate.committedKind = String(Reflect.get(result, 'kind'))
        gate.paused = true
        await new Promise<void>((resolve) => {
          gate.resume = resolve
        })
      }
      return result
    }
  })
  return async () => {
    if (!page.isClosed()) {
      await page.evaluate(() => {
        (window as unknown as { __logoutAfterBegin?: { readonly resume: () => void } }).__logoutAfterBegin?.resume()
      })
    }
  }
}

/** 仅返回持久状态名，独立于应用内的流程状态和界面文字。 */
export async function localSessionSummary(page: Page) {
  return page.evaluate(async () => new Promise<{ phase?: string, generation?: string, activatedFrom?: string, suspendedFrom?: string } | undefined>((resolve, reject) => {
    const opened = indexedDB.open('nerve-office-outbox')
    opened.onerror = () => reject(opened.error)
    opened.onsuccess = () => {
      const db = opened.result
      const tx = db.transaction('sessions', 'readonly')
      const request = tx.objectStore('sessions').get('current') as IDBRequest<{ readonly state?: { readonly phase?: string, readonly generation?: string, readonly activatedFrom?: string, readonly suspendedFrom?: string } } | undefined>
      tx.oncomplete = () => {
        db.close()
        const state = request.result?.state
        resolve(state === undefined ? undefined : { phase: state.phase, generation: state.generation, activatedFrom: state.activatedFrom, suspendedFrom: state.suspendedFrom })
      }
      tx.onabort = () => {
        db.close()
        reject(tx.error)
      }
    }
  }))
}

export async function localSessionPhase(page: Page): Promise<string | undefined> {
  return (await localSessionSummary(page))?.phase
}
