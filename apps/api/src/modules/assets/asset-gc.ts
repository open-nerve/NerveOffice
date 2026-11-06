import type { Transaction } from '../database/index.ts'
import type { AssetGcPolicy } from './asset-gc-policy.ts'

/** 调用时已持资产排他锁；只能读取保留关系，不反向锁空间、文档或检查点。 */
export interface AssetRetentionProbe {
  retained: (ids: readonly string[], transaction: Transaction) => Promise<ReadonlySet<string>>
}

export interface AssetGcPage {
  readonly through: string
  readonly after?: string
  readonly limit: number
}

export interface AssetGcAssetPage {
  readonly scanned: number
  readonly marked: number
  readonly reset: number
  readonly removed: number
  /** 宽限已满但被恢复水位挡住的资源记录（M5R-M-03） */
  readonly blocked: number
  readonly policy: AssetGcPolicy['state']
  readonly lastId?: string
}

export type AssetGcObjectKind = 'object' | 'claim'
export interface AssetGcObjectPage {
  readonly scanned: number
  readonly marked: number
  readonly reset: number
  readonly queued: number
  /** 宽限已满但被恢复水位挡住的物理对象或预留（M5R-M-03） */
  readonly blocked: number
  readonly bytes: number
  readonly policy: AssetGcPolicy['state']
  readonly lastHash?: string
}
