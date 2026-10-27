import type { ProcessedImage } from './image-types.ts'
import type { AssetObjectKey } from './storage-adapter.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStorage } from './file-storage.ts'
import { assetObjectKey } from './storage-adapter.ts'

function image(text = 'abc'): ProcessedImage {
  const data = Buffer.from(text)
  return { data, sha256: createHash('sha256').update(data).digest('hex'), mimeType: 'image/png', width: 1, height: 1, frames: 1, bytes: data.length }
}

let scratch: string
let root: string
let storage: FileStorage
beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'nerve-asset-storage-')))
  root = join(scratch, 'private')
  storage = new FileStorage(root)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(scratch, { recursive: true, force: true })
})

describe('私有不可变文件存储', () => {
  it('初始化不依赖数据库占用：清旧 probe，保留待发布 tmp，实际发布仍须取得占用', async () => {
    await storage.initialize()
    const probe = join(root, 'staging', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.probe')
    const temporary = join(root, 'staging', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.tmp')
    await fs.writeFile(probe, 'p', { mode: 0o600 })
    await fs.writeFile(temporary, 'charged upload', { mode: 0o600 })
    const reopened = new FileStorage(root, {
      tryRun: async () => {
        throw new Error('database unavailable')
      },
    })
    await reopened.initialize()
    expect(await fs.readdir(join(root, 'staging'))).toEqual(['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.tmp'])
    await expect(reopened.publish(image(), assetObjectKey(image().sha256))).rejects.toMatchObject({ reason: 'io' })
    expect(await fs.readFile(temporary, 'utf8')).toBe('charged upload')
  })

  it('并发初始化清理活跃 probe 的名字也不妨碍其打开句柄完成写入和同步', async () => {
    let entered: () => void
    const opened = new Promise<void>((resolve) => {
      entered = resolve
    })
    let resume: () => void
    const continuation = new Promise<void>((resolve) => {
      resume = resolve
    })
    const open = fs.open.bind(fs)
    let paused = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.probe') && !paused) {
        paused = true
        entered()
        await continuation
      }
      return handle
    })
    const first = storage.initialize()
    try {
      await opened
      await new FileStorage(root).initialize()
    }
    finally {
      resume!()
      await first
    }
    expect(await fs.readdir(join(root, 'staging'))).toEqual([])
  })

  it('初始化独占创建遇到已有文件时，不清理没有取得所有权的文件', async () => {
    const open = fs.open.bind(fs)
    let foreign: string | undefined
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const path = String(args[0])
      if (path.includes('/staging/')) {
        foreign = path
        await fs.writeFile(path, 'belongs-to-another-task')
      }
      return open(...args)
    })
    await expect(storage.initialize()).rejects.toMatchObject({ operation: 'initialize', reason: 'io' })
    expect(foreign).toBeDefined()
    expect(await fs.readFile(foreign!, 'utf8')).toBe('belongs-to-another-task')
  })

  it('发布后完整可读，文件 0600、目录 0700，重新打开仍可读', async () => {
    await storage.initialize()
    const key = await storage.publish(image(), assetObjectKey(image().sha256))
    expect(key).toBe('objects/ba/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await storage.read(key, image())).toEqual(Buffer.from('abc'))
    expect((await fs.stat(join(root, key))).mode & 0o777).toBe(0o600)
    for (const path of [root, join(root, 'objects'), join(root, 'objects/ba'), join(root, 'staging')])
      expect((await fs.stat(path)).mode & 0o777).toBe(0o700)
    const reopened = new FileStorage(root)
    await reopened.initialize()
    expect(await reopened.read(key, image())).toEqual(Buffer.from('abc'))
    expect(await fs.readdir(join(root, 'staging'))).toEqual([])
  })

  it('同对象并发发布只保留一份，已有 inode 和字节不变', async () => {
    await storage.initialize()
    const keys = await Promise.all(Array.from({ length: 8 }, async () => storage.publish(image(), assetObjectKey(image().sha256))))
    const first = await fs.stat(join(root, keys[0]!))
    expect(new Set(keys).size).toBe(1)
    expect(await fs.readdir(join(root, 'objects/ba'))).toEqual([image().sha256])
    await storage.publish(image(), assetObjectKey(image().sha256))
    expect((await fs.stat(join(root, keys[0]!))).ino).toBe(first.ino)
    expect(await storage.read(keys[0]!, image())).toEqual(Buffer.from('abc'))
    expect(await fs.readdir(join(root, 'staging'))).toEqual([])
  })

  it('在首个 await 前固定输入字节，调用方随后改 buffer 不影响已发布对象', async () => {
    await storage.initialize()
    const input = image()
    const publishing = storage.publish(input, assetObjectKey(input.sha256))
    input.data.fill(0)
    const key = await publishing
    expect(await storage.read(key, image())).toEqual(Buffer.from('abc'))
  })

  it.each(['xyz', 'longer-than-original'])('同名文件内容已损坏（%s）时拒绝读取和发布，不覆盖它', async (corrupt) => {
    await storage.initialize()
    const key = await storage.publish(image(), assetObjectKey(image().sha256))
    await fs.writeFile(join(root, key), corrupt)
    await expect(storage.read(key, image())).rejects.toMatchObject({ operation: 'read', reason: 'integrity' })
    await expect(storage.publish(image(), assetObjectKey(image().sha256))).rejects.toMatchObject({ operation: 'publish', reason: 'integrity' })
    expect(await fs.readFile(join(root, key), 'utf8')).toBe(corrupt)
    expect(await fs.readdir(join(root, 'staging'))).toEqual([])
  })

  it('摘要或声明长度不符的内部结果不会写临时或正式文件', async () => {
    await storage.initialize()
    for (const patch of [{ sha256: '0'.repeat(64) }, { bytes: 4 }])
      await expect(storage.publish({ ...image(), ...patch }, assetObjectKey(image().sha256))).rejects.toThrow()
    expect(await fs.readdir(join(root, 'objects'))).toEqual([])
    expect(await fs.readdir(join(root, 'staging'))).toEqual([])
  })

  it.each(['relative', '/', '/tmp/assets\u0000'])('拒绝不合法根路径 %j', (path) => {
    expect(() => new FileStorage(path)).toThrow()
  })

  it('拒绝根目录、祖先或对象命名空间符号链接，不在链接目标写入', async () => {
    const elsewhere = join(scratch, 'elsewhere')
    await fs.mkdir(elsewhere, { mode: 0o700 })
    await fs.symlink(elsewhere, root)
    await expect(storage.initialize()).rejects.toMatchObject({ reason: 'unsafe-path' })
    await expect(new FileStorage(join(root, 'nested')).initialize()).rejects.toMatchObject({ reason: 'unsafe-path' })
    expect(await fs.readdir(elsewhere)).toEqual([])
    await fs.unlink(root)
    await fs.mkdir(root, { mode: 0o700 })
    await fs.symlink(elsewhere, join(root, 'objects'))
    await expect(storage.initialize()).rejects.toMatchObject({ reason: 'unsafe-path' })
    expect(await fs.readdir(elsewhere)).toEqual([])
  })

  it.each(['objects', 'staging', 'objects/ba'])('运行中 %s 换成符号链接时拒绝发布，不触碰外部目录', async (part) => {
    await storage.initialize()
    const elsewhere = join(scratch, 'elsewhere')
    await fs.mkdir(elsewhere, { mode: 0o700 })
    await fs.rm(join(root, part), { recursive: true, force: true })
    await fs.symlink(elsewhere, join(root, part))
    await expect(storage.publish(image(), assetObjectKey(image().sha256))).rejects.toMatchObject({ reason: 'unsafe-path' })
    expect(await fs.readdir(elsewhere)).toEqual([])
  })

  it('已有对象为符号链接时不能通过校验或覆盖，目标原样保留', async () => {
    await storage.initialize()
    const key = await storage.publish(image(), assetObjectKey(image().sha256))
    const elsewhere = join(scratch, 'elsewhere')
    await fs.writeFile(elsewhere, 'abc', { mode: 0o600 })
    await fs.unlink(join(root, key))
    await fs.symlink(elsewhere, join(root, key))
    await expect(storage.read(key, image())).rejects.toMatchObject({ reason: 'unsafe-path' })
    await expect(storage.publish(image(), assetObjectKey(image().sha256))).rejects.toMatchObject({ reason: 'unsafe-path' })
    expect(await fs.readFile(elsewhere, 'utf8')).toBe('abc')
    expect((await fs.lstat(join(root, key))).isSymbolicLink()).toBe(true)
  })

  it('目录不能充当文件；宽松目录权限不被自动修改或接受', async () => {
    await storage.initialize()
    const key = assetObjectKey(image().sha256)
    await fs.mkdir(join(root, key), { recursive: true, mode: 0o700 })
    await expect(storage.read(key, image())).rejects.toMatchObject({ reason: 'unsafe-path' })
    await fs.chmod(root, 0o755)
    await expect(storage.publish(image(), assetObjectKey(image().sha256))).rejects.toMatchObject({ reason: 'unsafe-path' })
    expect((await fs.stat(root)).mode & 0o777).toBe(0o755)
  })

  it('不接受越界/不规范对象键，预期摘要不能与对象键矛盾', async () => {
    await storage.initialize()
    for (const sha256 of ['../outside', 'A'.repeat(64), '0'.repeat(63)])
      expect(() => assetObjectKey(sha256)).toThrow()
    for (const key of ['../outside', '/etc/passwd', `objects/00/${image().sha256}`, `${assetObjectKey(image().sha256)}/extra`])
      await expect(storage.read(key as AssetObjectKey, image())).rejects.toMatchObject({ reason: 'invalid-key' })
    const key = await storage.publish(image(), assetObjectKey(image().sha256))
    await expect(storage.read(key, { ...image(), sha256: '0'.repeat(64) })).rejects.toMatchObject({ reason: 'invalid-key' })
  })

  it('发布 IO 失败只清本任务临时文件，下一请求可正常发布', async () => {
    await storage.initialize()
    const foreign = join(root, 'staging', 'foreign-file')
    await fs.writeFile(foreign, 'leave-alone')
    const linking = vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('private path must not leak'), { code: 'EIO' }))
    await expect(storage.publish(image(), assetObjectKey(image().sha256))).rejects.toMatchObject({ operation: 'publish', reason: 'io' })
    expect(await fs.readdir(join(root, 'staging'))).toEqual(['foreign-file'])
    expect(await fs.readdir(join(root, 'objects/ba'))).toEqual([])
    linking.mockRestore()
    expect(await storage.read(await storage.publish(image(), assetObjectKey(image().sha256)), image())).toEqual(Buffer.from('abc'))
    expect(await fs.readFile(foreign, 'utf8')).toBe('leave-alone')
  })

  it('临时文件 fsync 失败不发布，清理后能重试', async () => {
    await storage.initialize()
    const open = fs.open.bind(fs)
    const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).includes('/staging/'))
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('sync failed'), { code: 'EIO' }))
      return handle
    })
    await expect(storage.publish(image(), assetObjectKey(image().sha256))).rejects.toMatchObject({ operation: 'publish', reason: 'io' })
    expect(await fs.readdir(join(root, 'objects/ba'))).toEqual([])
    expect(await fs.readdir(join(root, 'staging'))).toEqual([])
    opening.mockRestore()
    expect(await storage.read(await storage.publish(image(), assetObjectKey(image().sha256)), image())).toEqual(Buffer.from('abc'))
  })

  it('正式目录 fsync 失败保留已完整发布的文件，重试安全去重', async () => {
    await storage.initialize()
    const open = fs.open.bind(fs)
    const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === join(root, 'objects/ba'))
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('sync failed'), { code: 'EIO' }))
      return handle
    })
    await expect(storage.publish(image(), assetObjectKey(image().sha256))).rejects.toMatchObject({ operation: 'publish', reason: 'io' })
    const key = assetObjectKey(image().sha256)
    expect(await fs.readFile(join(root, key), 'utf8')).toBe('abc')
    expect(await fs.readdir(join(root, 'staging'))).toEqual([])
    opening.mockRestore()
    expect(await storage.read(await storage.publish(image(), assetObjectKey(image().sha256)), image())).toEqual(Buffer.from('abc'))
  })
})
