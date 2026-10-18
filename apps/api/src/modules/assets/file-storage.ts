import type { FileHandle } from 'node:fs/promises'
import type { ProcessedImage } from './image-types.ts'
import type { AssetObjectKey, StorageAdapter, StorageOperation, StoredImageExpectation } from './storage-adapter.ts'
import type { TemporaryFileLeases } from './temporary-files.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { IMAGE_LIMITS, validateProcessedImage } from './image-types.ts'
import { assetObjectKey, AssetStorageError } from './storage-adapter.ts'

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function storageFailure(operation: StorageOperation, error: unknown): AssetStorageError {
  const reason = error instanceof AssetStorageError
    ? error.reason
    : ['ELOOP', 'ENOTDIR'].includes(String(errorCode(error))) ? 'unsafe-path' : 'io'
  return new AssetStorageError(operation, reason)
}

/**
 * 本地私有卷（ADR-021）。根与命名空间由服务端独占、不可含符号链接，0700/0600；每次操作重新检查。
 * 不覆盖对象，完整临时文件 sync 后 hard link 原子发布，再 sync 目录；数据库只在 publish 兑现后转正。
 * Node 没有跨平台 openat：这些检查不承诺防止有权改本进程私有目录的管理员在检查后替换祖先路径。
 */
export class FileStorage implements StorageAdapter {
  readonly #root: string
  #initialized = false

  // 独立 FS 单元测试可不注入占用（不执行跨实例回收）；正式模块始终注入数据库占用适配器。
  constructor(root: string, private readonly temporaryLeases?: TemporaryFileLeases) {
    if (!isAbsolute(root) || root.includes('\0') || resolve(root) === dirname(resolve(root)))
      throw new AssetStorageError('initialize', 'unsafe-path')
    this.#root = resolve(root)
  }

  async initialize(): Promise<void> {
    try {
      // 检查已有父路径后才创建根：不能通过符号链接祖先把目录建到别处。
      const parent = dirname(this.#root)
      if (await fs.realpath(parent) !== parent)
        throw new AssetStorageError('initialize', 'unsafe-path')
      const created = await this.#directory(this.#root, true)
      await this.#directory(join(this.#root, 'objects'), true)
      await this.#directory(join(this.#root, 'staging'), true)
      // 启动的本地写入探针不依赖数据库，保留数据库不可达时的 live/ready 契约。
      // probe 从不参与 link 发布：拿到句柄后先去掉名字，再写入与同步；并发清名字不影响句柄。
      await this.#clearProbes()
      const candidate = join(this.#root, 'staging', `${randomUUID()}.probe`)
      {
        const handle = await this.#newFile(candidate)
        try {
          try {
            await this.#removeTemporary(candidate, 'initialize')
            await handle.writeFile(new Uint8Array([0]))
            await handle.sync()
          }
          finally {
            await handle.close()
          }
        }
        finally {
          await this.#removeTemporary(candidate, 'initialize')
        }
      }
      await this.#syncDirectory(join(this.#root, 'staging'))
      await this.#syncDirectory(join(this.#root, 'objects'))
      await this.#syncDirectory(this.#root)
      if (created)
        await this.#syncDirectory(parent)
      this.#initialized = true
    }
    catch (error) {
      throw storageFailure('initialize', error)
    }
  }

  async publish(value: ProcessedImage): Promise<AssetObjectKey> {
    // 在首个 await 前固定字节；再次验证副本，不能让之后的 buffer 修改写成与对象键不同的内容。
    const checked = validateProcessedImage(value)
    const image = validateProcessedImage({ ...checked, data: Buffer.from(checked.data) })
    const key = assetObjectKey(image.sha256)
    try {
      await this.#base('publish')
      await this.#directory(join(this.#root, 'staging'))
      await this.#clearAbandoned('publish')
      const shard = dirname(join(this.#root, key))
      if (await this.#directory(shard, true))
        await this.#syncDirectory(join(this.#root, 'objects'))
      return await this.#temporary('publish', async (candidate) => {
        const handle = await this.#newFile(candidate)
        try {
          try {
            await handle.writeFile(image.data)
            await handle.sync()
          }
          finally {
            await handle.close()
          }
          try {
            await fs.link(candidate, join(this.#root, key))
          }
          catch (error) {
            if (errorCode(error) !== 'EEXIST')
              throw error
            // 原子发布的另一方已成功；不能只凭文件名/大小去重，更不能覆盖损坏对象。
            await this.#readFile(key, image, true)
          }
          await this.#syncDirectory(shard)
          return key
        }
        finally {
          await this.#removeTemporary(candidate, 'publish')
        }
      })
    }
    catch (error) {
      throw storageFailure('publish', error)
    }
  }

  async read(key: AssetObjectKey, expected: StoredImageExpectation): Promise<Uint8Array> {
    try {
      await this.#base('read')
      return await this.#readFile(key, expected, false)
    }
    catch (error) {
      throw storageFailure('read', error)
    }
  }

  async #readFile(key: AssetObjectKey, expected: StoredImageExpectation, synchronize: boolean): Promise<Uint8Array> {
    let canonical: AssetObjectKey
    try {
      canonical = assetObjectKey(expected.sha256)
    }
    catch {
      throw new AssetStorageError('read', 'invalid-key')
    }
    if (key !== canonical || !Number.isInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > IMAGE_LIMITS.maxBytes)
      throw new AssetStorageError('read', 'invalid-key')
    const file = join(this.#root, key)
    await this.#directory(dirname(file))
    // NONBLOCK 防止被意外换成 FIFO 时挂住；fstat 后只接受私有普通文件。
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid()))
        throw new AssetStorageError('read', 'unsafe-path')
      if (stat.size !== expected.bytes)
        throw new AssetStorageError('read', 'integrity')
      // 不用 readFile：即使打开后文件意外增长，也最多读取上限 + 1 字节。
      const buffer = Buffer.alloc(expected.bytes + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
        if (bytesRead === 0)
          break
        offset += bytesRead
      }
      const data = buffer.subarray(0, offset)
      if (offset !== expected.bytes || createHash('sha256').update(data).digest('hex') !== expected.sha256)
        throw new AssetStorageError('read', 'integrity')
      if (synchronize)
        await handle.sync()
      return data
    }
    finally {
      await handle.close()
    }
  }

  async #base(operation: StorageOperation): Promise<void> {
    if (!this.#initialized)
      throw new AssetStorageError(operation, 'not-initialized')
    if (await fs.realpath(this.#root) !== this.#root)
      throw new AssetStorageError(operation, 'unsafe-path')
    await this.#directory(this.#root)
    await this.#directory(join(this.#root, 'objects'))
  }

  async #directory(path: string, create = false): Promise<boolean> {
    let created = false
    if (create) {
      try {
        await fs.mkdir(path, { mode: 0o700 })
        created = true
      }
      catch (error) {
        if (errorCode(error) !== 'EEXIST')
          throw error
      }
    }
    const stat = await fs.lstat(path)
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (process.getuid !== undefined && stat.uid !== process.getuid()))
      throw new AssetStorageError('initialize', 'unsafe-path')
    return created
  }

  async #syncDirectory(path: string): Promise<void> {
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await handle.sync()
    }
    finally {
      await handle.close()
    }
  }

  async #temporary<T>(operation: StorageOperation, work: (path: string) => Promise<T>): Promise<T> {
    const id = randomUUID()
    const run = async (): Promise<T> => work(join(this.#root, 'staging', `${id}.tmp`))
    if (this.temporaryLeases === undefined)
      return run()
    const result = await this.temporaryLeases.tryRun(id, run)
    if (!result.ran)
      throw new AssetStorageError(operation, 'io')
    return result.result
  }

  async #clearAbandoned(operation: StorageOperation): Promise<void> {
    if (this.temporaryLeases === undefined)
      return
    const staging = join(this.#root, 'staging')
    const entries = await fs.opendir(staging)
    for await (const entry of entries) {
      const id = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/.exec(entry.name)?.[1]
      if (id === undefined)
        continue
      await this.temporaryLeases.tryRun(id, async () => this.#discardTemporary(join(staging, entry.name), operation))
    }
  }

  async #clearProbes(): Promise<void> {
    const staging = join(this.#root, 'staging')
    for await (const entry of await fs.opendir(staging)) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.probe$/.test(entry.name))
        await this.#discardTemporary(join(staging, entry.name), 'initialize')
    }
  }

  async #discardTemporary(path: string, operation: StorageOperation): Promise<void> {
    const stat = await fs.lstat(path).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT')
        return undefined
      throw error
    })
    if (stat === undefined)
      return
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid()))
      throw new AssetStorageError(operation, 'unsafe-path')
    await this.#removeTemporary(path, operation)
    await this.#syncDirectory(dirname(path))
  }

  async #newFile(path: string): Promise<FileHandle> {
    return fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  }

  async #removeTemporary(path: string, operation: StorageOperation): Promise<void> {
    try {
      await fs.unlink(path)
    }
    catch (error) {
      if (errorCode(error) !== 'ENOENT')
        throw storageFailure(operation, error)
    }
  }
}
