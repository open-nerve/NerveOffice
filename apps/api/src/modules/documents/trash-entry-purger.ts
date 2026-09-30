import type { AuditActionDetailsInput, TrashEntryKind } from '@nerve-office/contracts'
import type { AuditEvent, AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { FolderRow } from './folders.repository.ts'
import type { TrashEntryRow } from './trash-entries.repository.ts'
import { Injectable } from '@nestjs/common'
import { AuditService } from '../audit/index.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { FoldersRepository } from './folders.repository.ts'
import { TrashEntriesRepository } from './trash-entries.repository.ts'

/**
 * 永久删除一个删除单元的结果（审计与调用方用）。不带标题与名称：到期自动清理的 jobs 模块拿到的只有 id 与份数，
 * 它的日志与审计因此不会经手标题（M2-P6 复核 M-1）
 */
export interface PurgeOutcome {
  /** 被永久删除的那一个对象：文档 id 或文件夹 id */
  readonly objectId: string
  readonly kind: TrashEntryKind
  readonly spaceId: string
  readonly folders: number
  readonly documents: number
  /** 连带删掉的别的删除单元（子树里早先单独删过的东西，spec §4） */
  readonly cascadedEntryIds: string[]
}

/** 审计里的操作者：人工操作是本人，到期自动清理（S4）是系统。 */
export type TrashActor = AuditEvent['actor']

/** 这一单的根文件夹：它的父文件夹不在这一单里（一个删除单元就是一棵子树，所以只有一个）。恢复与永久删除都用它。 */
export function rootFolderOf(entryId: string, unit: readonly FolderRow[]): FolderRow {
  const inUnit = new Set(unit.map(row => row.id))
  const roots = unit.filter(row => row.parentId === null || !inUnit.has(row.parentId))
  const root = roots[0]
  if (root === undefined || roots.length !== 1)
    throw new Error(`一个文件夹的删除单元里有 ${roots.length} 个根：${entryId}`)
  return root
}

/**
 * 永久删除一个删除单元的本体（spec §4）：**不判断任何人的权限**，调用方必须已经取得这个空间的树锁、空间行、
 * 文档行与回收站行，并且已经判断过谁能做（或者操作者就是系统）。只有两个调用方，都在 documents 模块里：
 * - TrashService.purge：人工的永久删除，锁下判断过权限之后调用；
 * - TrashPurgeService.purgeExpired：到期的自动清理（只给 jobs，操作者记为系统）。
 *
 * 它不从模块的公开入口导出，也不在模块的 exports 里：别的模块（workspace 等）拿到的 TrashService 上
 * 没有不判断权限就能永久删除的方法（M2-P6 复核 A 的 G1；eslint 的 no-restricted-imports 与模块边界另外拦下）。
 */
@Injectable()
export class TrashEntryPurger {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly folders: FoldersRepository,
    private readonly entries: TrashEntriesRepository,
    private readonly audit: AuditService,
  ) {}

  async purge(entry: TrashEntryRow, actor: TrashActor, origin: AuditOrigin, transaction: Transaction): Promise<PurgeOutcome> {
    const outcome = entry.kind === 'document'
      ? await this.purgeDocument(entry, transaction)
      : await this.purgeFolder(entry, transaction)
    const emptied = await this.deleteEmptied([entry.id, ...outcome.cascadedEntryIds], transaction)
    if (!emptied.includes(entry.id))
      throw new Error(`永久删除之后删除单元里还有东西：${entry.id}`)
    await this.record({
      action: entry.kind === 'document' ? 'documents.purged' : 'folders.purged',
      // 只记份数与删除单元，不记标题与名称（M2 总设计 §2.1 第 5 条，M2-P6 复核 M-1）。
      // 连带删掉几个删除单元（spec §4）：只记份数，不记 id 列表——审计明细有 AUDIT_DETAILS_MAX_BYTES 的上限，
      // 无界的 id 数组在连带上百个单元时会让整条写入失败，那一单因此永远删不掉（审查 A1）
      details: {
        spaceId: entry.spaceId,
        trashEntryId: entry.id,
        folders: outcome.folders,
        documents: outcome.documents,
        cascadedEntries: emptied.filter(id => id !== entry.id).length,
      },
    }, actor, { type: entry.kind, id: outcome.objectId }, origin, transaction)
    return outcome
  }

  /** 一份文档的删除单元：只有这一行，没有可以连带的子孙。 */
  private async purgeDocument(entry: TrashEntryRow, transaction: Transaction): Promise<PurgeOutcome> {
    const documents = await this.documents.lockInEntries([entry.id], transaction)
    const documentId = documents[0]?.id
    if (documentId === undefined || documents.length !== 1)
      throw new Error(`一份文档的删除单元里有 ${documents.length} 份文档：${entry.id}`)
    await this.documents.deleteMany([documentId], transaction)
    return { objectId: documentId, kind: 'document', spaceId: entry.spaceId, folders: 0, documents: 1, cascadedEntryIds: [] }
  }

  /**
   * 一个文件夹的删除单元：这一单里的全部行，以及子树里属于别的删除单元的行（spec §4 的"连带"）。
   * 先删文档再删文件夹（外键是 restrict，文档指着文件夹）；文档的内容与修订记录随外键 cascade
   */
  private async purgeFolder(entry: TrashEntryRow, transaction: Transaction): Promise<PurgeOutcome> {
    const root = rootFolderOf(entry.id, await this.folders.listInEntry(entry.id, transaction))
    // 不按状态过滤地展开整棵子树：里面可能还有早先单独删过、属于别的删除单元的东西
    const folderIds = (await this.folders.summarizeSubtree(root.id, null, transaction)).ids
    const documents = await this.documents.lockInFolders(folderIds, entry.spaceId, transaction)
    await this.requireAllTrashed(entry, folderIds, transaction)
    const documentIds = documents.map(row => row.id)
    const cascadedEntryIds = [...new Set([
      ...documents.flatMap(row => row.trashEntryId ?? []),
      ...await this.folders.trashEntryIdsIn(folderIds, transaction),
    ])].filter(id => id !== entry.id)

    await this.documents.deleteMany(documentIds, transaction)
    await this.folders.deleteMany(folderIds, transaction)
    return { objectId: root.id, kind: 'folder', spaceId: entry.spaceId, folders: folderIds.length, documents: documentIds.length, cascadedEntryIds }
  }

  /**
   * 不变量"要删的都在回收站里"（spec §4；M2-P6 复核 A 的 S-3、B 的 B2）：展开出来的文件夹与它们里面的文档，
   * 每一行都属于这一单或被连带的删除单元，也就是都不是正常状态。
   * 这一条只由服务保证（删除文件夹时整棵正常状态的子树一起进回收站，往回收站的文件夹里新建、移入都找不到目标，
   * 结构性的改动都在锁下核对对象还在锁着的空间里），数据库里没有约束。万一不成立（某条路径在错的锁下改动过），
   * 永久删除会把正常状态的文件夹与文档一起删掉，而且恢复不了。所以删之前用计数核对一次：有正常状态的行就按数据不一致处理——
   * 抛出意外错误，整个事务回滚、什么也不删，错误日志里有这一单的 id；人工的永久删除回答 500，到期的清理记为失败、之后再试
   */
  private async requireAllTrashed(entry: TrashEntryRow, folderIds: readonly string[], transaction: Transaction): Promise<void> {
    const folders = await this.folders.countActive(folderIds, transaction)
    const documents = await this.documents.countActiveInFolders(folderIds, transaction)
    if (folders > 0 || documents > 0)
      throw new Error(`永久删除的子树里有正常状态的行（文件夹 ${folders} 个、文档 ${documents} 份），什么也不删：${entry.id}`)
  }

  /** 这些删除单元里已经没有任何行的那些（永久删除之后），一起删掉并返回真正删掉的 id。 */
  private async deleteEmptied(candidates: readonly string[], transaction: Transaction): Promise<string[]> {
    const [documents, folders] = await Promise.all([
      this.documents.countByTrashEntries(candidates, transaction),
      this.folders.countByTrashEntries(candidates, transaction),
    ])
    const emptied = candidates.filter(id => (documents.get(id) ?? 0) === 0 && (folders.get(id) ?? 0) === 0)
    await this.entries.deleteMany(emptied, transaction)
    return emptied
  }

  /** 动作与明细一起给出：明细按动作的严格结构（contracts 的 auditDetailsSchema），只有 id 与份数 */
  private async record(
    audit: Extract<AuditActionDetailsInput, { action: 'documents.purged' | 'folders.purged' }>,
    actor: TrashActor,
    target: { readonly type: 'document' | 'folder', readonly id: string },
    origin: AuditOrigin,
    transaction: Transaction,
  ): Promise<void> {
    await this.audit.record({ ...audit, actor, target, origin }, { transaction })
  }
}
