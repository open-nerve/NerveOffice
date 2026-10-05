// 保存的 requestId 幂等（M3-P3 设计 §3.1 第 2 步、§3.7，00 号计划书 §7.4 第 2 步）：一次保存的结果记在修订记录里（写入了新的修订），
// 或者记在回执里（内容与当前相同、修订号没变）。同一个人对同一份文档的同一次保存（负载摘要一致）重试时，原样给出原来的结果——
// 修订号与保存时间，回执的另有 unchanged——不论之后编辑权、客户端的版本与校验的规则怎样（A07）。
import type { SaveContentResponse } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { RevisionRow } from './document-revisions.repository.ts'
import type { ReceiptRow } from './document-save-receipts.repository.ts'

/** 同一个 requestId 已经有的记录：修订记录（保存、新建、复制、另存为副本的都在这张表里）与回执，各至多一条 */
export interface RecordedRequest {
  readonly revision: RevisionRow | undefined
  readonly receipt: ReceiptRow | undefined
}

/** 这个 requestId 已经用过（不论是不是这一次保存） */
export function isRecorded(recorded: RecordedRequest): boolean {
  return recorded.revision !== undefined || recorded.receipt !== undefined
}

/** 一条修订记录作为保存的结果：修订号与那一行的时间，修订号增加了 */
export function savedOutcome(revision: RevisionRow): SaveContentResponse {
  return { revision: revision.revision, savedAt: revision.createdAt.toISOString(), unchanged: false }
}

/**
 * 是这个人对这份文档的同一次保存（种类是保存、摘要一致）时给出原来的结果；否则 undefined（没有记录、别人的、别的文档的、
 * 内容或标记不同的、或者那是一次新建、复制、另存为副本）
 */
export function replayedSave(recorded: RecordedRequest, userId: string, documentId: string, digest: Buffer): SaveContentResponse | undefined {
  const { revision, receipt } = recorded
  if (revision !== undefined && revision.kind === 'saved' && revision.documentId === documentId && revision.savedBy === userId && revision.payloadDigest.equals(digest))
    return savedOutcome(revision)
  if (receipt !== undefined && receipt.documentId === documentId && receipt.savedBy === userId && receipt.payloadDigest.equals(digest))
    return { revision: receipt.revision, savedAt: receipt.savedAt.toISOString(), unchanged: true }
  return undefined
}
