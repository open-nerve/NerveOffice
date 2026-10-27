import type { DocumentProfile, PlatformFormatVersion } from '@nerve-office/contracts'
import type { HistoryMaterial } from './document-history.repository.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { KeyedQuota } from '../../shared/keyed-quota.ts'
import { Semaphore, SemaphoreBusyError } from '../../shared/semaphore.ts'
import { gunzipWithin } from '../security/index.ts'
import { documentTooNew } from './client-format-gate.ts'
import { SnapshotInspector } from './snapshot-inspector.ts'

export interface ValidatedHistory {
  readonly record: HistoryMaterial
  readonly profile: DocumentProfile
  readonly formatVersion: PlatformFormatVersion
}

/** 准入必须包住正文加载和写入完成；大 JSON 仍只交现有子进程检查器。 */
@Injectable()
export class DocumentHistoryValidation {
  private readonly slots = new Semaphore(2, { maxWaiting: 0 })
  private readonly accounts = new KeyedQuota(1)

  constructor(private readonly inspector: SnapshotInspector) {}

  async admit<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const release = this.accounts.tryAcquire(userId)
    if (release === undefined)
      throw busy()
    try {
      return await this.slots.run(task)
    }
    catch (error) {
      if (error instanceof SemaphoreBusyError)
        throw busy()
      throw error
    }
    finally {
      release()
    }
  }

  async validate(record: HistoryMaterial, userId: string): Promise<ValidatedHistory> {
    if (documentTooNew(record) || record.snapshot.length < 1 || record.snapshot.length > SNAPSHOT_MAX_RAW_BYTES
      || record.snapshot.length !== record.storedBytes || record.rawBytes < 1 || record.rawBytes > SNAPSHOT_MAX_RAW_BYTES
      || !createHash('sha256').update(record.snapshot).digest().equals(record.snapshotHash)
      || (record.contentHash === null) !== (record.resourceNames === null)) {
      throw new AppError('HISTORY_UNUSABLE')
    }
    let raw: Buffer
    try {
      raw = await gunzipWithin(record.snapshot, SNAPSHOT_MAX_RAW_BYTES)
    }
    catch (error) {
      if (error instanceof AppError && (error.code === 'REQUEST_INVALID' || error.code === 'PAYLOAD_TOO_LARGE'))
        throw new AppError('HISTORY_UNUSABLE')
      throw error
    }
    if (raw.length !== record.rawBytes)
      throw new AppError('HISTORY_UNUSABLE')
    const profile = DOCUMENT_PROFILE_OF[record.type]
    // 上面已确认原信封就是当前支持的档案/格式；这里只收窄类型，不进行格式迁移。
    const outcome = await this.inspector.inspect(raw, profile, userId)
    if (!outcome.ok || outcome.unitId !== record.unitId)
      throw new AppError('HISTORY_UNUSABLE')
    if (record.contentHash !== null && !record.contentHash.equals(Buffer.from(outcome.contentHash)))
      throw new AppError('HISTORY_UNUSABLE')
    if (record.resourceNames !== null) {
      const names = [...record.resourceNames].sort()
      const actual = [...outcome.nonEmptyResources].sort()
      if (names.length !== actual.length || names.some((name, index) => name !== actual[index]))
        throw new AppError('HISTORY_UNUSABLE')
    }
    return { record, profile, formatVersion: PLATFORM_FORMAT_VERSION }
  }
}

function busy(): AppError {
  return new AppError('SERVICE_UNAVAILABLE', '历史恢复正在处理中，请稍后重试', { headers: { 'Retry-After': '5' } })
}
