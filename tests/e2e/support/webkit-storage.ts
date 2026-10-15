// macOS Playwright 的持久上下文未隔离 OPFS 根。只重定向到真实根下的独占子目录，
// 不替换文件、句柄、事务或清理结果。页面和 Worker 必须使用相同目录。
import type { BrowserContext, TestInfo } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

const workerPreludes = new WeakMap<BrowserContext, string>()

/** page.route 优先于 context.route；故障夹具改写 Worker 时仍须沿用同一真实存储目录。 */
export function namespaceWorkerScript(context: BrowserContext, script: string): string {
  return (workerPreludes.get(context) ?? '') + script
}

/** 此函数会序列化到页面与 Worker，不能引用模块作用域。 */
function installNamespace(namespace: string): void {
  const storage = navigator.storage
  // about:blank 等非安全来源没有 StorageManager；不能让夹具异常阻断其他 initScript（例如测试时钟）。
  if (storage === undefined || typeof storage.getDirectory !== 'function')
    return
  const prototype = Object.getPrototypeOf(storage) as StorageManager
  const original: typeof storage.getDirectory = Reflect.get(prototype, 'getDirectory')
  const nativeRoot = async () => Reflect.apply(original, storage, [])
  Reflect.set(globalThis, Symbol.for('nerve-office/e2e/native-opfs-root'), nativeRoot)
  prototype.getDirectory = async function () {
    return (await nativeRoot()).getDirectoryHandle(namespace, { create: true })
  }
}

/** 关闭浏览器前保存本例的原始文件，再只删除本例目录；失败时不删除未归档数据。 */
async function archiveNamespace(context: BrowserContext, profile: string, namespace: string, origin: string): Promise<void> {
  await context.setOffline(false)
  await context.unrouteAll({ behavior: 'ignoreErrors' })
  for (const page of context.pages())
    await page.close()
  const page = await context.newPage()
  await page.goto(`${origin}/api/health/ready`)
  const snapshot = await page.evaluate(async (namespace) => {
    const nativeRoot = Reflect.get(globalThis, Symbol.for('nerve-office/e2e/native-opfs-root')) as () => Promise<FileSystemDirectoryHandle>
    const root = await nativeRoot()
    let owned: FileSystemDirectoryHandle
    try {
      owned = await root.getDirectoryHandle(namespace)
    }
    catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError')
        return { directories: [], files: [] }
      throw error
    }
    const directories: string[][] = []
    const files: { path: string[], base64: string }[] = []
    type Directory = FileSystemDirectoryHandle & { values: () => AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle> }
    async function visit(directory: FileSystemDirectoryHandle, path: string[]): Promise<void> {
      directories.push(path)
      for await (const handle of (directory as Directory).values()) {
        const next = [...path, handle.name]
        if (handle.kind === 'directory') {
          await visit(handle, next)
        }
        else {
          const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
          let binary = ''
          for (let at = 0; at < bytes.length; at += 32_768)
            binary += String.fromCharCode(...bytes.subarray(at, at + 32_768))
          files.push({ path: next, base64: btoa(binary) })
        }
      }
    }
    await visit(owned, [])
    return { directories, files }
  }, namespace)
  const output = join(profile, 'opfs-archive')
  const fileManifest: { path: string[], bytes: number, sha256: string }[] = []
  for (const parts of [...snapshot.directories, ...snapshot.files.map(file => file.path)]) {
    if (parts.some(part => part === '' || part === '.' || part === '..' || /[/\\]/.test(part)))
      throw new Error('OPFS 归档路径不合法')
  }
  for (const parts of snapshot.directories)
    await mkdir(join(output, 'files', ...parts), { recursive: true })
  for (const file of snapshot.files) {
    const path = join(output, 'files', ...file.path)
    const bytes = Buffer.from(file.base64, 'base64')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: 'wx' })
    fileManifest.push({ path: file.path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ namespace, origin, directories: snapshot.directories, files: fileManifest }, null, 2), { flag: 'wx' })
  await page.evaluate(async (namespace) => {
    const nativeRoot = Reflect.get(globalThis, Symbol.for('nerve-office/e2e/native-opfs-root')) as () => Promise<FileSystemDirectoryHandle>
    try {
      await (await nativeRoot()).removeEntry(namespace, { recursive: true })
    }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError')
        throw error
    }
  }, namespace)
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({ removed: true, namespace }), { flag: 'wx' })
}

/** 性能测量不使用此适配：路由会关闭 HTTP 缓存；该类测量仍在原生持久上下文串行运行。 */
export async function isolateWebkitStorage(context: BrowserContext, profile: string, testInfo: TestInfo): Promise<void> {
  if (process.platform !== 'darwin' || testInfo.project.use.browserName !== 'webkit')
    return
  const baseURL = testInfo.project.use.baseURL
  if (baseURL === undefined)
    throw new Error('OPFS 隔离需要明确的测试来源')
  const origin = new URL(baseURL).origin
  // 中断可能来不及归档；新启动不能因资料目录路径复用而读到上轮残留。
  const namespace = `nerve-office-e2e-${randomUUID()}`
  const prelude = `(${installNamespace.toString()})(${JSON.stringify(namespace)});\n`
  workerPreludes.set(context, prelude)
  await context.addInitScript(installNamespace, namespace)
  await context.route(/\/assets\/[^/]+\.worker-[^/]+\.js(?:\?.*)?$/, async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      await route.fallback()
      return
    }
    const response = await route.fetch()
    if (!response.ok()) {
      await route.fulfill({ response })
      return
    }
    await route.fulfill({ response, body: namespaceWorkerScript(context, await response.text()) })
  })
  testInfo.annotations.push({ type: 'webkit-opfs-namespace', description: namespace })
  const close = context.close.bind(context)
  let closed = false
  let closing: Promise<void> | undefined
  context.on('close', () => {
    closed = true
    workerPreludes.delete(context)
  })
  context.close = async (options) => {
    closing ??= (async () => {
      try {
        if (!closed)
          await archiveNamespace(context, profile, namespace, origin)
      }
      finally {
        await close(options)
      }
    })()
    return closing
  }
}
