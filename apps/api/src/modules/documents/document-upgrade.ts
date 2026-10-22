import type { DocumentUpgradeFailureCode, DocumentUpgradeStatus } from '@nerve-office/contracts'

export const DOCUMENT_UPGRADE_LOCK = 'nerve-office:document-upgrade-writes'

export interface DocumentUpgradeBatch {
  readonly id: string
  readonly targetVersion: string
  readonly status: DocumentUpgradeStatus
  readonly sourceCount: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly completedAt: Date | null
  readonly failureCode: DocumentUpgradeFailureCode | null
}

export interface DocumentUpgradeReceipt {
  readonly batch: (DocumentUpgradeBatch & { readonly completedCount: number }) | null
  readonly activeBatchId: string | null
  readonly writeFrozen: boolean
}

export type DocumentUpgradeErrorCode = DocumentUpgradeFailureCode | 'target_invalid' | 'batch_size_invalid' | 'batch_id_invalid' | 'batch_not_found' | 'batch_active' | 'batch_inactive' | 'not_ready'

const messages: Record<DocumentUpgradeErrorCode, string> = {
  target_invalid: '目标标识须为 1–128 个 ASCII 字符，以字母或数字开头，仅含字母数字及 ._:@/-。',
  batch_size_invalid: '每批份数须为 1–100 的整数。',
  batch_id_invalid: '批次标识须为 UUID。',
  batch_not_found: '没有这个升级检查点批次。',
  batch_active: '已有冻结批次；先执行 status，再选择 resume、release 或 abort。',
  batch_inactive: '这个批次不是当前冻结批次，不能改动其他批次的冻结。',
  not_ready: '检查点批次尚未 ready；先执行 resume。',
  source_changed: '源修订与冻结清单不一致；保持冻结，需核对源数据。',
  source_incomplete: '源文档、正文或当前修订不完整；不能确认升级检查点完整。',
  checkpoint_incomplete: '检查点缺失、过期或不对应冻结清单；保持冻结，执行 resume 接续。',
  database_failure: '升级检查点操作未能确认完成；先执行 status 核对持久状态，冻结不会自动解除。',
}

export class DocumentUpgradeError extends Error {
  constructor(readonly code: DocumentUpgradeErrorCode) {
    super(messages[code])
    this.name = 'DocumentUpgradeError'
  }
}
