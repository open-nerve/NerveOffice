import type { FileHandle } from 'node:fs/promises'
import type { ProcessedImage } from './image-types.ts'
import type { AssetObjectKey, StorageAdapter, StorageOperation, StoredImageExpectation } from './storage-adapter.ts'
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

  constructor(root: string) {
    if (!isAbsolute(root) || root.includes('\0') || resolve(root) === dirname(resolve(root)))
      throw new AssetStorageError('initialize', 'unsafe-path')
    this.#root = resolve(root)
  }

  async initialize(): Promise<void> {
    let probe: string | undefined
    try {
      // 检查已有父路径后才创建根：不能通过符号链接祖先把目录建到别处。
      const parent = dirname(this.#root)
      if (await fs.realpath(parent) !== parent)
        throw new AssetStorageError('initialize', 'unsafe-path')
      const created = await this.#directory(this.#root, true)
      await this.#directory(join(this.#root, 'objects'), true)
      await this.#directory(join(this.#root, 'staging'), true)
      const candidate = this.#temporaryPath()
      const handle = await this.#newFile(candidate)
      probe = candidate
      try {
        await handle.writeFile(new Uint8Array([0]))
        await handle.sync()
      }
      finally {
        await handle.close()
      }
      await fs.unlink(probe)
      probe = undefined
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
    finally {
      if (probe !== undefined)
        await this.#removeTemporary(probe, 'initialize')
    }
  }

  async publish(value: ProcessedImage): Promise<AssetObjectKey> {
    // 在首个 await 前固定字节；再次验证副本，不能让之后的 buffer 修改写成与对象键不同的内容。
    const checked = validateProcessedImage(value)
    const image = validateProcessedImage({ ...checked, data: Buffer.from(checked.data) })
    const key = assetObjectKey(image.sha256)
    let temporary: string | undefined
    try {
      await this.#base('publish')
      await this.#directory(join(this.#root, 'staging'))
      const shard = dirname(join(this.#root, key))
      if (await this.#directory(shard, true))
        await this.#syncDirectory(join(this.#root, 'objects'))
      const candidate = this.#temporaryPath()
      const handle = await this.#newFile(candidate)
      temporary = candidate
      try {
        await handle.writeFile(image.data)
        await handle.sync()
      }
      finally {
        await handle.close()
      }
      try {
        await fs.link(temporary, join(this.#root, key))
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
    catch (error) {
      throw storageFailure('publish', error)
    }
    finally {
      if (temporary !== undefined)
        await this.#removeTemporary(temporary, 'publish')
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

  #temporaryPath(): string {
    return join(this.#root, 'staging', `${randomUUID()}.tmp`)
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
