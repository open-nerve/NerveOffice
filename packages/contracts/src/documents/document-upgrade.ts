/** 运维检查点的有限状态与失败原因；审计、数据库和 CLI 共用，不能塞入原始错误或正文。 */
export const DOCUMENT_UPGRADE_STATUSES = ['preparing', 'failed', 'ready', 'released', 'aborted'] as const
export type DocumentUpgradeStatus = (typeof DOCUMENT_UPGRADE_STATUSES)[number]
export const DOCUMENT_UPGRADE_FAILURE_CODES = ['source_changed', 'source_incomplete', 'checkpoint_incomplete', 'database_failure'] as const
export type DocumentUpgradeFailureCode = (typeof DOCUMENT_UPGRADE_FAILURE_CODES)[number]
export const DOCUMENT_UPGRADE_TARGET_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'

export function isDocumentUpgradeTarget(value: string): boolean {
  // 与数据库的 ASCII 范围相同；这里用 JS 的大小写标志和 \w 表达。
  return /^[a-z0-9][\w.:@/-]{0,127}$/i.test(value)
}
