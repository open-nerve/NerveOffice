import type { SessionService } from '../auth/index.ts'
import type { AppConfig } from '../config/index.ts'
import type { TransactionRunner } from '../database/index.ts'
import type { ApplicationState } from '../health/index.ts'
import type { AssetsRepository } from './assets.repository.ts'
import type { ImageRunner, ImageRunnerFailure } from './image-runner.ts'
import type { ImageProcessingInput } from './image-types.ts'
import type { StorageAdapter } from './storage-adapter.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { AssetUploadService } from './asset-upload.service.ts'
import { ImageRunnerError } from './image-runner.ts'
import { assetObjectKey, AssetStorageError } from './storage-adapter.ts'

const SHA = 'a'.repeat(64)
const IMAGE = { data: new Uint8Array(68), sha256: SHA, mimeType: 'image/png', width: 1, height: 1, frames: 1, bytes: 68 } as const
const INPUT: ImageProcessingInput = { data: new Uint8Array(1234), mimeType: 'image/png', extension: 'png' }
const FAILURE = '图片上传处理失败'

interface Faults { readonly process?: Error, readonly reserve?: Error, readonly publish?: Error }

/** 只伪造上传服务的协作者；日志走真实的根日志与 AppLogger，按行解析 */
function setup(faults: Faults = {}) {
  const lines: string[] = []
  const logger = new AppLogger(createRootLogger({ level: 'info', destination: { write: (line: string) => void lines.push(line) } }), new RequestContextStore())
  const repository = {
    reserve: vi.fn(async () => {
      if (faults.reserve !== undefined)
        throw faults.reserve
      return { sha256: SHA, generation: null, storageKey: assetObjectKey(SHA) }
    }),
    finalize: vi.fn(async () => undefined),
  }
  const transactions = { run: async <T>(work: (transaction: never) => Promise<T>) => work(undefined as never) }
  const sessions = { requireActive: async () => undefined }
  const storage = {
    initialize: async () => undefined,
    publish: vi.fn(async (_image: unknown, key: string) => {
      if (faults.publish !== undefined)
        throw faults.publish
      return key
    }),
    read: vi.fn(),
    retire: vi.fn(),
  }
  const runner = {
    initialize: async () => undefined,
    close: async () => undefined,
    process: vi.fn(async () => {
      if (faults.process !== undefined)
        throw faults.process
      return IMAGE
    }),
  }
  const application = { shutdownSignal: new AbortController().signal }
  const service = new AssetUploadService(
    repository as unknown as AssetsRepository,
    transactions as unknown as TransactionRunner,
    sessions as unknown as SessionService,
    storage as unknown as StorageAdapter,
    runner as unknown as ImageRunner,
    application as unknown as ApplicationState,
    { assets: {} } as unknown as AppConfig,
    logger,
  )
  const upload = async (read: (signal: AbortSignal) => Promise<ImageProcessingInput> = async () => INPUT) =>
    service.upload({ userId: 'uploader', sessionId: 'session' }, read, new AbortController().signal)
  const failures = () => lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.msg === FAILURE)
  return { upload, failures, lines }
}

describe('M5R-M-01 上传失败的服务端日志只记阶段、分类、输入字节数与耗时', () => {
  it.each<ImageRunnerFailure>(['initialization', 'protocol', 'crashed', 'codec', 'timeout', 'heap'])('子进程失败 %s：记处理阶段与原因', async (reason) => {
    const error = new ImageRunnerError(reason)
    const { upload, failures } = setup({ process: error })
    await expect(upload()).rejects.toBe(error)
    const entries = failures()
    expect(entries).toMatchObject([{ level: 'warn', module: 'assets', stage: 'process', reason, inputBytes: 1234 }])
    expect(entries[0]!.durationMs).toBeTypeOf('number')
  })

  it('发布文件时存储失败：记发布阶段与存储的有界原因', async () => {
    const { upload, failures } = setup({ publish: new AssetStorageError('publish', 'unsafe-path') })
    await expect(upload()).rejects.toMatchObject({ name: 'AssetStorageError', reason: 'unsafe-path' })
    expect(failures()).toMatchObject([{ stage: 'publish', reason: 'unsafe-path', inputBytes: 1234 }])
  })

  it('其他异常记为 unexpected，不带原始消息里的路径或参数', async () => {
    const { upload, failures, lines } = setup({ reserve: new Error('controlled failure /private/secret-path') })
    await expect(upload()).rejects.toThrow('controlled failure')
    expect(failures()).toMatchObject([{ stage: 'reserve', reason: 'unexpected', inputBytes: 1234 }])
    expect(lines.join('\n')).not.toContain('secret-path')
  })

  it('字段集合封闭：不含文件内容、文件名、类型或用户标识', async () => {
    const { upload, failures } = setup({ process: new ImageRunnerError('crashed') })
    await expect(upload()).rejects.toBeInstanceOf(ImageRunnerError)
    // hostname、pid、time、level 是根日志每行都有的基础字段
    expect(Object.keys(failures()[0]!).sort()).toEqual(['durationMs', 'hostname', 'inputBytes', 'level', 'module', 'msg', 'pid', 'reason', 'stage', 'time'])
  })

  it('读请求体之前失败时没有输入字节数', async () => {
    const { upload, failures } = setup()
    await expect(upload(async () => {
      throw new Error('controlled reader failure')
    })).rejects.toThrow('controlled reader failure')
    const [entry] = failures()
    expect(entry).toMatchObject({ stage: 'read', reason: 'unexpected' })
    expect(entry).not.toHaveProperty('inputBytes')
  })

  it('可以归到这个请求的拒绝与客户端取消不记为处理失败', async () => {
    const rejected = setup()
    await expect(rejected.upload(async () => {
      throw new AppError('ASSET_INVALID', undefined, { details: { rule: 'too-complex' } })
    })).rejects.toMatchObject({ code: 'ASSET_INVALID' })
    expect(rejected.failures()).toEqual([])
    const cancelled = setup()
    await expect(cancelled.upload(async () => {
      throw new DOMException('图片请求已取消', 'AbortError')
    })).rejects.toMatchObject({ code: 'REQUEST_INVALID' })
    expect(cancelled.failures()).toEqual([])
  })

  it('成功的上传不记失败', async () => {
    const { upload, failures } = setup()
    await expect(upload()).resolves.toMatchObject({ bytes: 68, mimeType: 'image/png' })
    expect(failures()).toEqual([])
  })
})
