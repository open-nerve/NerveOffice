// 上传的快照的检查结果怎样交给保存与另存为副本（M3-P3 设计 §3.1 第 4 步、§3.12）：与文档无关的规则在子进程里查（SnapshotInspector），
// 不合格时记一条 warn——规则与文档 id，不记快照的内容——再回答 SNAPSHOT_INVALID（details.rule）；与文档有关的两条（unitId、不缩水）
// 在事务里查，被拒时同样记 warn。快照的档案用服务端的（DOCUMENT_PROFILE_OF.sheet）：v0.1 只有表格，事务里另核对文档的档案
// （client-format-gate.ts 的 requireWritableDocument；M6 有了文字文档之后按文档的类型选档案）
import type { SnapshotRule } from '@nerve-office/contracts'
import type { AppError } from '../../shared/errors/app-error.ts'
import type { AppLogger } from '../logging/index.ts'
import type { GzipBody } from '../security/index.ts'
import type { InspectionOutcome, SnapshotInspector } from './snapshot-inspector.ts'
import { DOCUMENT_PROFILE_OF } from '@nerve-office/contracts'
import { snapshotInvalid } from './snapshot-inspector.ts'

/** 检查时用的档案（见文件开头） */
export const INSPECTED_PROFILE = DOCUMENT_PROFILE_OF.sheet

/** 检查通过的快照：unitId、规范化的内容哈希（32 字节）、这一版里在的与其中非空的资源名（按名称排序） */
export type PassedSnapshot = Extract<InspectionOutcome, { readonly ok: true }>

/** 快照被拒：记一条 warn（规则、文档 id 与调用方给的少量事实，不记内容），给出 SNAPSHOT_INVALID 的错误 */
export function rejectedSnapshot(logger: AppLogger, rule: SnapshotRule, documentId: string, fields: Record<string, unknown> = {}): AppError {
  logger.warn('快照不合格，拒绝写入', { rule, documentId, ...fields })
  return snapshotInvalid(rule)
}

/**
 * 上传的快照过一遍与文档无关的检查：通过时交回结果（unitId、内容哈希、资源名）；不合格时抛 SNAPSHOT_INVALID（见 rejectedSnapshot）。
 * requesterId 是发起的账户：检查池按账户限份数（INSPECTIONS_PER_ACCOUNT，审查 A2）。
 * 这个账户的份数已满、检查器繁忙、子进程崩溃或超时时它自己抛 503（带 Retry-After）
 */
export async function requirePassingSnapshot(inspector: SnapshotInspector, logger: AppLogger, upload: GzipBody, documentId: string, requesterId: string): Promise<PassedSnapshot> {
  const outcome = await inspector.inspect(upload.decompressed, INSPECTED_PROFILE, requesterId)
  if (!outcome.ok)
    throw rejectedSnapshot(logger, outcome.rule, documentId, { rawBytes: upload.decompressed.length })
  return outcome
}
