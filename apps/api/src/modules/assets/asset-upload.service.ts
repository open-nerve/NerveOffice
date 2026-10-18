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
import { AssetsRepository } from './assets.repository.ts'
import { imageAborted, ImageAdmission, imageBusy } from './image-admission.ts'
import { ImageRunner } from './image-runner.ts'
import { ASSET_STORAGE } from './storage-adapter.ts'

/** 只有取得名额后才调用 reader；HTTP 请求在此之前不会缓存正文。 */
export type ImageInputReader = (signal: AbortSignal) => Promise<ImageProcessingInput>

export interface AssetUploadActor {
  readonly userId: string
  readonly sessionId: string
}

@Injectable()
export class AssetUploadService implements OnModuleInit, OnModuleDestroy {
  readonly #admission = new ImageAdmission()
  readonly #closing = new AbortController()
  readonly #pending = new Set<Promise<unknown>>()

  constructor(
    private readonly repository: AssetsRepository,
    private readonly transactions: TransactionRunner,
    private readonly sessions: SessionService,
    @Inject(ASSET_STORAGE) private readonly storage: StorageAdapter,
    private readonly runner: ImageRunner,
    private readonly application: ApplicationState,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.storage.initialize()
    await this.runner.initialize()
  }

  async upload(actor: AssetUploadActor, read: ImageInputReader, signal: AbortSignal): Promise<AssetUploadResponse> {
    const combined = AbortSignal.any([signal, this.#closing.signal, this.application.shutdownSignal])
    const operation = this.#admission.run(actor.userId, combined, async () => {
      this.#requireActive(combined)
      const input = await read(combined)
      this.#requireActive(combined)
      const image = await this.runner.process(input, combined)
      this.#requireActive(combined)
      // 只有预留提交已确认，才允许文件发布。未知结果不释放占用，也不继续写文件。
      await this.transactions.run(async (transaction) => {
        await this.repository.reserve(image, this.config.assets, transaction)
        // 在等锁与写入之后复核，撤销若已提交则连同本次预留一起回滚（ADR-017/018）。
        await this.sessions.requireActive(actor.sessionId, transaction)
      })
      this.#requireActive(combined)
      await this.storage.publish(image)
      this.#requireActive(combined)
      const assetId = randomUUID()
      await this.transactions.run(async (transaction) => {
        await this.repository.finalize(assetId, actor.userId, image, this.config.assets, transaction)
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
