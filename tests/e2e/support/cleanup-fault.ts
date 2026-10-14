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
