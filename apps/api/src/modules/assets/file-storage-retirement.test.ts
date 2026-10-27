import type { ProcessedImage } from './image-types.ts'
import type { AssetObjectKey } from './storage-adapter.ts'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStorage } from './file-storage.ts'
import { assetObjectKey } from './storage-adapter.ts'

const FIRST = '10000000-0000-4000-8000-000000000001'
const SECOND = '10000000-0000-4000-8000-000000000002'
const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const value: ProcessedImage = {
  data: Buffer.from('abc'),
  sha256: createHash('sha256').update('abc').digest('hex'),
  mimeType: 'image/png',
  width: 1,
  height: 1,
  frames: 1,
  bytes: 3,
}
let scratch: string
let root: string
let storage: FileStorage
beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'nerve-retirement-')))
  root = join(scratch, 'private')
  storage = new FileStorage(root)
  await storage.initialize()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(scratch, { recursive: true, force: true })
})

describe('图片对象代次隔离', () => {
  it('同一 hash 的不同代次使用不同规范路径，旧路径仍保持原样', () => {
    expect(assetObjectKey(HASH, FIRST)).toBe(`objects/ba/${HASH}.${FIRST}`)
    expect(assetObjectKey(HASH, SECOND)).toBe(`objects/ba/${HASH}.${SECOND}`)
    expect(assetObjectKey(HASH, null)).toBe(`objects/ba/${HASH}`)
  })

  it.each(['../new', '', `${FIRST}\n`, FIRST.toUpperCase().replace('1', 'A'), '10000000-0000-4000-8000-00000000000g'])('拒绝不规范的服务端代次 %j', (generation) => {
    expect(() => assetObjectKey(HASH, generation)).toThrow()
  })

  it('发布按回执路径写入，两个代次都能从各自路径读取，重新初始化不改变它们', async () => {
    const first = assetObjectKey(HASH, FIRST)
    const second = assetObjectKey(HASH, SECOND)
    expect(await storage.publish(value, first)).toBe(first)
    expect(await storage.publish(value, second)).toBe(second)
    expect((await fs.readdir(join(root, 'objects/ba'))).sort()).toEqual([`${HASH}.${FIRST}`, `${HASH}.${SECOND}`])
    const reopened = new FileStorage(root)
    await reopened.initialize()
    expect(await reopened.read(first, value)).toEqual(Buffer.from('abc'))
    expect(await reopened.read(second, value)).toEqual(Buffer.from('abc'))
  })

  it.each([
    `objects/ba/${HASH}.${FIRST}/../other`,
    `objects/aa/${HASH}.${FIRST}`,
    `objects/ba/${HASH}.invalid`,
    `objects/cc/${'c'.repeat(64)}.${FIRST}`,
  ])('发布与读取拒绝不属于这份摘要的规范路径 %j', async (key) => {
    await expect(storage.publish(value, key as AssetObjectKey)).rejects.toMatchObject({ operation: 'publish', reason: 'invalid-key' })
    await expect(storage.read(key as AssetObjectKey, value)).rejects.toMatchObject({ operation: 'read', reason: 'invalid-key' })
    expect(await fs.readdir(join(root, 'objects'))).toEqual([])
  })
})

describe('不可再发布的退休路径', () => {
  it.each([null, FIRST])('退休旧路径或代次 %j 后，图片正文消失且旧上传不能再发布', async (generation) => {
    const key = assetObjectKey(HASH, generation)
    await storage.publish(value, key)
    await storage.retire(key, value)
    const stat = await fs.stat(join(root, key))
    expect(stat.size).toBe(0)
    expect(stat.mode & 0o777).toBe(0o600)
    await expect(storage.read(key, value)).rejects.toMatchObject({ reason: 'integrity' })
    await expect(storage.publish(value, key)).rejects.toMatchObject({ reason: 'integrity' })
    expect(await fs.readdir(join(root, 'staging'))).toEqual([])
  })

  it('尚未发布的 claim 也留下标记；旧退休重放不能修改新代次', async () => {
    const first = assetObjectKey(HASH, FIRST)
    const second = assetObjectKey(HASH, SECOND)
    await storage.retire(first, value)
    await expect(storage.publish(value, first)).rejects.toMatchObject({ reason: 'integrity' })
    await storage.publish(value, second)
    const inode = (await fs.stat(join(root, second))).ino
    const reopened = new FileStorage(root)
    await reopened.initialize()
    await Promise.all(Array.from({ length: 8 }, async () => reopened.retire(first, value)))
    expect((await fs.stat(join(root, first))).size).toBe(0)
    expect((await fs.stat(join(root, second))).ino).toBe(inode)
    expect(await reopened.read(second, value)).toEqual(Buffer.from('abc'))
  })

  it.each(['before-link', 'after-link'])('旧发布停在 %s，退休和新上传完成后恢复，不能重新留下图片正文', async (stage) => {
    const first = assetObjectKey(HASH, FIRST)
    const second = assetObjectKey(HASH, SECOND)
    let signalEntered: () => void
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    let resume: () => void
    const continuation = new Promise<void>((resolve) => {
      resume = resolve
    })
    const link = fs.link.bind(fs)
    vi.spyOn(fs, 'link').mockImplementation(async (...args) => {
      if (String(args[1]) !== join(root, first))
        return link(...args)
      if (stage === 'after-link')
        await link(...args)
      signalEntered()
      await continuation
      if (stage === 'before-link')
        await link(...args)
    })
    const publishing = storage.publish(value, first)
    const result = stage === 'before-link'
      ? expect(publishing).rejects.toMatchObject({ reason: 'integrity' })
      : expect(publishing).resolves.toBe(first)
    try {
      await entered
      await storage.retire(first, value)
      await storage.publish(value, second)
    }
    finally {
      resume!()
      await result
    }
    expect((await fs.stat(join(root, first))).size).toBe(0)
    expect(await storage.read(second, value)).toEqual(Buffer.from('abc'))
  })

  it.each(['before-rename', 'after-rename'])('%s 文件故障保留可接续状态，下一次退休成功', async (stage) => {
    const key = assetObjectKey(HASH, FIRST)
    await storage.publish(value, key)
    const rename = fs.rename.bind(fs)
    const fault = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      if (stage === 'after-rename')
        await rename(...args)
      throw Object.assign(new Error('private path must not leak'), { code: 'EIO' })
    })
    await expect(storage.retire(key, value)).rejects.toMatchObject({ operation: 'retire', reason: 'io' })
    expect((await fs.stat(join(root, key))).size).toBe(stage === 'before-rename' ? 3 : 0)
    expect(await fs.readdir(join(root, 'staging'))).toEqual([])
    fault.mockRestore()
    await storage.retire(key, value)
    expect((await fs.stat(join(root, key))).size).toBe(0)
  })

  it.each(['marker', 'shard'])('%s 同步失败不能报告成功，重试保留永久标记', async (stage) => {
    const key = assetObjectKey(HASH, FIRST)
    await storage.publish(value, key)
    const open = fs.open.bind(fs)
    const fault = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if ((stage === 'marker' && String(args[0]).includes('/staging/')) || (stage === 'shard' && String(args[0]) === join(root, 'objects/ba')))
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('sync failed'), { code: 'EIO' }))
      return handle
    })
    await expect(storage.retire(key, value)).rejects.toMatchObject({ operation: 'retire', reason: 'io' })
    expect((await fs.stat(join(root, key))).size).toBe(stage === 'marker' ? 3 : 0)
    fault.mockRestore()
    await storage.retire(key, value)
    await expect(storage.publish(value, key)).rejects.toMatchObject({ reason: 'integrity' })
  })

  it.each(['symlink', 'directory', 'fifo', 'permissions'])('拒绝退休 %s 目标，不改写它', async (kind) => {
    const key = assetObjectKey(HASH, FIRST)
    const target = join(root, key)
    await fs.mkdir(join(root, 'objects/ba'), { mode: 0o700 })
    const outside = join(scratch, 'outside')
    await fs.writeFile(outside, 'keep', { mode: 0o600 })
    if (kind === 'symlink') {
      await fs.symlink(outside, target)
    }
    else if (kind === 'directory') {
      await fs.mkdir(target, { mode: 0o700 })
    }
    else if (kind === 'fifo') {
      await promisify(execFile)('mkfifo', [target])
    }
    else {
      await fs.writeFile(target, 'abc', { mode: 0o644 })
      // 明确注入权限过宽的目标，避免宿主 umask 将故障样本收紧为安全的 0600。
      await fs.chmod(target, 0o644)
    }
    const before = await fs.lstat(target)
    await expect(storage.retire(key, value)).rejects.toMatchObject({ operation: 'retire', reason: 'unsafe-path' })
    expect((await fs.lstat(target)).ino).toBe(before.ino)
    expect(await fs.readFile(outside, 'utf8')).toBe('keep')
  })

  it('不接受错误回执或未初始化的存储，也不能经过被换成链接的 shard', async () => {
    const key = assetObjectKey(HASH, FIRST)
    await expect(new FileStorage(root).retire(key, value)).rejects.toMatchObject({ reason: 'not-initialized' })
    for (const patch of [{ sha256: 'c'.repeat(64) }, { bytes: 0 }, { bytes: 5242881 }])
      await expect(storage.retire(key, { ...value, ...patch })).rejects.toMatchObject({ reason: 'invalid-key' })
    const outside = join(scratch, 'outside')
    await fs.mkdir(outside, { mode: 0o700 })
    await fs.symlink(outside, join(root, 'objects/ba'))
    await expect(storage.retire(key, value)).rejects.toMatchObject({ reason: 'unsafe-path' })
    expect(await fs.readdir(outside)).toEqual([])
  })
})
