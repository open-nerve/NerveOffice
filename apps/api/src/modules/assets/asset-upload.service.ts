import type { AssetUploadResponse } from '@nerve-office/contracts'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { AppConfig } from '../config/index.ts'
import type { ImageProcessingInput } from './image-types.ts'
import type { StorageAdapter } from './storage-adapter.ts'
import { randomUUID } from 'node:crypto'
import { assetUrl } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { SessionService } from '../auth/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { ApplicationState } from '../health/index.ts'
import { AppLogger } from '../logging/index.ts'
import { AssetsRepository } from './assets.repository.ts'
import { imageAborted, ImageAdmission, imageBusy } from './image-admission.ts'
import { ImageRunner, ImageRunnerError } from './image-runner.ts'
import { ASSET_STORAGE, AssetStorageError } from './storage-adapter.ts'

/** 只有取得名额后才调用 reader；HTTP 请求在此之前不会缓存正文。 */
export type ImageInputReader = (signal: AbortSignal) => Promise<ImageProcessingInput>

export interface AssetUploadActor {
  readonly userId: string
  readonly sessionId: string
}

/** 上传失败停在哪一步（M5R-M-01）：admission 是排队取名额，之后依次读请求体、子进程处理、预留、发布文件、转正 */
type UploadStage = 'admission' | 'read' | 'process' | 'reserve' | 'publish' | 'finalize'

/**
 * 服务端要记下的失败分类（ADR-021：只记阶段、标识与错误分类）。子进程与存储的失败带有界的 reason；
 * 其余 AppError 是可以归到这个请求的拒绝（格式、配额、繁忙、会话失效），HTTP 日志已记状态，客户端取消也不是故障，都不再记；
 * 其他异常记为 unexpected，原始异常另由异常过滤器按脱敏规则记录
 */
function failureReasonOf(error: unknown): string | undefined {
  if (error instanceof ImageRunnerError || error instanceof AssetStorageError)
    return error.reason
  if (error instanceof AppError || (error instanceof DOMException && error.name === 'AbortError'))
    return undefined
  return 'unexpected'
}

@Injectable()
export class AssetUploadService implements OnModuleInit, OnModuleDestroy {
  readonly #admission = new ImageAdmission()
  readonly #closing = new AbortController()
  readonly #pending = new Set<Promise<unknown>>()
  readonly #logger: AppLogger

  constructor(
    private readonly repository: AssetsRepository,
    private readonly transactions: TransactionRunner,
    private readonly sessions: SessionService,
    @Inject(ASSET_STORAGE) private readonly storage: StorageAdapter,
    private readonly runner: ImageRunner,
    private readonly application: ApplicationState,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'assets' })
  }

  async onModuleInit(): Promise<void> {
    await this.storage.initialize()
    await this.runner.initialize()
  }

  async upload(actor: AssetUploadActor, read: ImageInputReader, signal: AbortSignal): Promise<AssetUploadResponse> {
    const combined = AbortSignal.any([signal, this.#closing.signal, this.application.shutdownSignal])
    const started = performance.now()
    // 只记阶段与输入的字节数：不含文件内容、文件名或用户输入（M5R-M-01）
    const trace: { stage: UploadStage, inputBytes: number | undefined } = { stage: 'admission', inputBytes: undefined }
    const operation = this.#admission.run(actor.userId, combined, async () => {
      trace.stage = 'read'
      this.#requireActive(combined)
      const input = await read(combined)
      trace.inputBytes = input.data.byteLength
      this.#requireActive(combined)
      trace.stage = 'process'
      const image = await this.runner.process(input, combined)
      this.#requireActive(combined)
      trace.stage = 'reserve'
      // 只有预留提交已确认，才允许文件发布。未知结果不释放占用，也不继续写文件。
      const reservation = await this.transactions.run(async (transaction) => {
        const reserved = await this.repository.reserve(image, this.config.assets, transaction)
        // 在等锁与写入之后复核，撤销若已提交则连同本次预留一起回滚（ADR-017/018）。
        await this.sessions.requireActive(actor.sessionId, transaction)
        return reserved
      })
      this.#requireActive(combined)
      trace.stage = 'publish'
      await this.storage.publish(image, reservation.storageKey)
      this.#requireActive(combined)
      trace.stage = 'finalize'
      const assetId = randomUUID()
      await this.transactions.run(async (transaction) => {
        await this.repository.finalize(assetId, actor.userId, image, this.config.assets, transaction, reservation)
        await this.sessions.requireActive(actor.sessionId, transaction)
      })
      return { assetId, url: assetUrl(assetId), mimeType: image.mimeType, width: image.width, height: image.height, bytes: image.bytes }
    })
    this.#pending.add(operation)
    try {
      return await operation
    }
    catch (error) {
      if (this.#closing.signal.aborted || this.application.shutdownSignal.aborted)
        throw imageBusy()
      if (error instanceof DOMException && error.name === 'AbortError')
        throw new AppError('REQUEST_INVALID', '图片上传已中断', { headers: { Connection: 'close' } })
      const reason = failureReasonOf(error)
      if (reason !== undefined)
        this.#logger.warn('图片上传处理失败', { stage: trace.stage, reason, inputBytes: trace.inputBytes, durationMs: Math.round(performance.now() - started) })
      throw error
    }
    finally {
      this.#pending.delete(operation)
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.#admission.close()
    this.#closing.abort()
    await this.runner.close()
    await Promise.allSettled([...this.#pending])
  }

  #requireActive(signal: AbortSignal): void {
    if (signal.aborted)
      throw imageAborted()
  }
}
