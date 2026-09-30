import type { AuditActionDetailsInput, RestoredTrashEntry, TrashEntryKind, TrashListQuery, TrashOrigin, TrashPermissions } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { Actor, SpaceContentAccess, TrashOperation } from './document-access-policy.ts'
import type { TrashedDocumentRow } from './documents.repository.ts'
import type { FolderRow } from './folders.repository.ts'
import type { TrashEntryRow } from './trash-entries.repository.ts'
import type { TrashActor } from './trash-entry-purger.ts'
import { TRASH_LIST_PAGE_SIZE } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { trashPermissionsOf } from './access-rules.ts'
import { DocumentAccessPolicy, requireDocumentContent, requireFolderContent, requireSpaceContent, requireTrashEntry } from './document-access-policy.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { FoldersRepository } from './folders.repository.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'
import { TrashEntriesRepository } from './trash-entries.repository.ts'
import { rootFolderOf, TrashEntryPurger } from './trash-entry-purger.ts'
import { WriteAccessRevocation } from './write-access.ts'

/**
 * 回收站列表的一条：显示名不在这里补（documents 模块不依赖 users，M2-P4 设计 §3.1），
 * 只给删除者的账户 id，由 workspace 的编排层换成显示名。
 */
export interface TrashEntrySummary {
  readonly id: string
  readonly spaceId: string
  readonly kind: TrashEntryKind
  readonly title: string
  readonly deletedBy: string
  readonly deletedAt: Date
  readonly expiresAt: Date
  readonly origin: TrashOrigin
  readonly documentCount: number
  readonly permissions: TrashPermissions
}

/** 回收站的一页：按删除时间从新到旧，还有下一页时给出游标。 */
export interface TrashPage {
  readonly items: TrashEntrySummary[]
  readonly nextCursor: string | null
}

/** 回收站这里记的四种审计（永久删除的两种由 TrashEntryPurger 记） */
type TrashAuditAction = 'documents.deleted' | 'documents.restored' | 'folders.deleted' | 'folders.restored'

/**
 * 回收站（M2-P4 设计 §3.4 第 3 条，规则细则见 specs/P4-S3-回收站的规则.md，US-M2-09）：
 * 按删除单元删除（一份文档，或一个文件夹连同它当时正常状态的整棵子树）、按空间列出、整单恢复、永久删除。
 *
 * 四个写操作都是结构性改动，所以都按同一个范式：不加锁判断 → 空间树的 advisory lock → 空间行 →
 * 文档行（按 id）→ 回收站行 → 锁下重新判断（ADR-007 的锁顺序）。
 * 回收站里的东西对普通接口一律"不存在"：仓储的 findById / lockById / accessible 都只取正常状态的行。
 */
@Injectable()
export class TrashService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly folders: FoldersRepository,
    private readonly entries: TrashEntriesRepository,
    private readonly tree: SpaceTreeRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
    private readonly writeAccess: WriteAccessRevocation,
    private readonly purger: TrashEntryPurger,
  ) {}

  /**
   * 一个空间的回收站（spec §6）：看得到空间内容的人都看得到这个列表（标题在删除之前他本来就看得到），
   * 能不能恢复、能不能永久删除由每一条的 permissions 给出。看不到与空间不存在都是 NOT_FOUND。
   */
  async list(actor: Actor, query: TrashListQuery): Promise<TrashPage> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    const access = await requireSpaceContent(this.policy, actor, query.spaceId, 'view')
    // 多取一条，判断还有没有下一页
    const rows = await this.entries.listBySpace(query.spaceId, { limit: TRASH_LIST_PAGE_SIZE + 1, after })
    const page = rows.slice(0, TRASH_LIST_PAGE_SIZE)
    const counts = await this.documents.countByTrashEntries(page.map(row => row.id))
    const parents = await this.folders.activeNamesOf(page.flatMap(row => row.originParentId ?? []), query.spaceId)
    const last = page.at(-1)
    return {
      items: page.map(row => this.toSummary(row, access, actor.userId, counts.get(row.id) ?? 0, parents)),
      nextCursor: rows.length > page.length && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
    }
  }

  /**
   * 删除一份文档（spec §1、§2）：空间管理员任意，编辑者只能删自己创建的；归档的空间里不能删。
   * 建一条删除单元，文档指向它并改为 trashed，写入代次加一并在同一个事务里收回写入权。
   */
  async deleteDocument(actor: Actor, id: string, origin: AuditOrigin): Promise<void> {
    await this.transactions.run(async (transaction) => {
      // 先判断（不加锁）：看不到与不能删的请求不取任何锁；看不到与不存在都是 NOT_FOUND
      const checked = await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(id, transaction), ['delete'], transaction)
      await this.tree.lock([checked.document.spaceId], transaction)
      await this.spaces.holdSpace(checked.document.spaceId, transaction)
      // 锁下重新读、重新判断：这期间它可能被移走、被别人删，空间可能被归档，自己可能被移出空间
      const { document } = await requireDocumentContent(this.policy, actor.userId, await this.documents.lockById(id, transaction), ['delete'], transaction)
      // 树锁是按取锁之前读到的空间取的：万一刚好有一次跨空间移动提交了，这把锁就保护不到它（与移动、改名相同）。
      // 这条范式由恢复那一处的集成用例代表（见 lockedEntry 的注释）
      if (document.spaceId !== checked.document.spaceId)
        throw new AppError('NOT_FOUND')

      const entry = await this.entries.insert({
        spaceId: document.spaceId,
        kind: 'document',
        deletedBy: actor.userId,
        originSpaceId: document.spaceId,
        originParentId: document.folderId,
        title: document.title,
      }, transaction)
      await this.documents.trash([document.id], entry.id, transaction)
      await this.writeAccess.revoke({ kind: 'documents', documentIds: [document.id] }, transaction)
      await this.record({
        action: 'documents.deleted',
        details: { spaceId: document.spaceId, folderId: document.folderId, trashEntryId: entry.id },
      }, { type: 'user', id: actor.userId }, { type: 'document', id: document.id }, origin, transaction)
    })
  }

  /**
   * 删除一个文件夹连同它当时正常状态的整棵子树（spec §1、§2）：空间管理员任意，
   * 编辑者还要"子树里正常状态的文档全部是本人创建的"——这一条在锁下用一条计数语句判断，展开子树之后再算。
   * 子树里早先单独删过、已经在回收站里的东西留在原来的删除单元里，不并进这次的。
   */
  async deleteFolder(actor: Actor, id: string, origin: AuditOrigin): Promise<void> {
    await this.transactions.run(async (transaction) => {
      // 先判断（不加锁）：看不到与不能删的请求不取任何锁
      const checked = await requireFolderContent(this.policy, actor, await this.folders.findById(id, transaction), ['delete'], transaction)
      await this.tree.lock([checked.folder.spaceId], transaction)
      await this.spaces.holdSpace(checked.folder.spaceId, transaction)
      const { folder, space } = await requireFolderContent(this.policy, actor, await this.folders.findById(id, transaction), ['delete'], transaction)
      // 同上：树锁按取锁之前读到的空间取，刚好被跨空间移走时这把锁保护不到它（范式见 lockedEntry 的注释）
      if (folder.spaceId !== checked.folder.spaceId)
        throw new AppError('NOT_FOUND')

      const folderIds = await this.folders.activeSubtreeIds(folder.id, transaction)
      // 文档行在文件夹之后锁（锁顺序：文件夹行 → 文档行）：保存内容不取树锁，所以要真的锁住它们
      const documents = await this.documents.lockInFolders(folderIds, folder.spaceId, transaction, 'active')
      // 编辑者只能删"里面只有本人创建的文档"的文件夹：锁下用一条计数语句判断（spec §2）
      // 单独一个错误码（不是 PERMISSION_DENIED）：这一条的说法是"换个人来删"，与"空间已归档，只能查看"
      // 是两回事，界面按错误码取文案时不能把两者说成同一句话（审查 B2）
      if (space.role !== 'admin' && await this.documents.countCreatedByOthers(folderIds, folder.spaceId, actor.userId, transaction) > 0)
        throw new AppError('FOLDER_HAS_OTHERS_DOCUMENTS')

      const entry = await this.entries.insert({
        spaceId: folder.spaceId,
        kind: 'folder',
        deletedBy: actor.userId,
        originSpaceId: folder.spaceId,
        originParentId: folder.parentId,
        title: folder.name,
      }, transaction)
      await this.folders.trashMany(folderIds, entry.id, transaction)
      const documentIds = documents.map(row => row.id)
      if (documentIds.length > 0) {
        await this.documents.trash(documentIds, entry.id, transaction)
        await this.writeAccess.revoke({ kind: 'documents', documentIds }, transaction)
      }
      await this.record({
        action: 'folders.deleted',
        details: { spaceId: folder.spaceId, parentId: folder.parentId, trashEntryId: entry.id, folders: folderIds.length, documents: documentIds.length },
      }, { type: 'user', id: actor.userId }, { type: 'folder', id: folder.id }, origin, transaction)
    })
  }

  /**
   * 整单恢复（spec §3）：删除者本人或当前的空间管理员；归档的空间里谁都不能。
   * 属于这个删除单元的全部行一起回到正常状态；被删的那一个对象回到原位置，原来的父文件夹已经不在
   * （被永久删除、自己也在回收站里）时回到空间的根目录，响应里带标志。写入代次不再加一。
   * 父文件夹跨空间移动时这个删除单元跟着一起搬走，所以父文件夹还在却在别的空间里是数据不一致，按意外错误处理（见 originParentOf）
   */
  async restore(actor: Actor, entryId: string, origin: AuditOrigin): Promise<RestoredTrashEntry> {
    return this.transactions.run(async (transaction) => {
      const checked = await requireTrashEntry(this.policy, actor, await this.entries.findById(entryId, transaction), ['restore'], transaction)
      await this.tree.lock([checked.entry.spaceId], transaction)
      await this.spaces.holdSpace(checked.entry.spaceId, transaction)
      // 先锁属于这一单的文档行，再锁回收站行（ADR-007 的锁顺序）；两者都用删除单元 id 找，不必先读它
      const documents = await this.documents.lockInEntries([entryId], transaction)
      const entry = await this.lockedEntry(actor, entryId, checked.entry.spaceId, ['restore'], transaction)

      const restored = entry.kind === 'document'
        ? await this.restoreDocument(entry, documents, transaction)
        : await this.restoreFolder(entry, transaction)
      await this.entries.deleteMany([entryId], transaction)
      await this.record({
        action: entry.kind === 'document' ? 'documents.restored' : 'folders.restored',
        details: { spaceId: entry.spaceId, folderId: restored.folderId, movedToRoot: restored.movedToRoot, trashEntryId: entryId },
      }, { type: 'user', id: actor.userId }, { type: entry.kind, id: restored.id }, origin, transaction)
      return restored
    })
  }

  /**
   * 永久删除一个删除单元（spec §4）：空间管理员 / 个人空间的所有者；归档的空间里不能。
   * 子树里属于别的删除单元的行一并永久删除（它们的原位置随这次删除消失），那些单元变空之后一起删掉。
   * 删除的本体在 TrashEntryPurger：它不判断权限，只在这里（锁下判断过之后）与到期的自动清理里调用，
   * 这个类上不留不判断权限就能永久删除的公开方法（M2-P6 复核 A 的 G1）
   */
  async purge(actor: Actor, entryId: string, origin: AuditOrigin): Promise<void> {
    await this.transactions.run(async (transaction) => {
      const checked = await requireTrashEntry(this.policy, actor, await this.entries.findById(entryId, transaction), ['purge'], transaction)
      await this.tree.lock([checked.entry.spaceId], transaction)
      await this.spaces.holdSpace(checked.entry.spaceId, transaction)
      // 先锁属于这一单的文档行，再锁回收站行（ADR-007 的锁顺序）
      await this.documents.lockInEntries([entryId], transaction)
      const entry = await this.lockedEntry(actor, entryId, checked.entry.spaceId, ['purge'], transaction)
      await this.purger.purge(entry, { type: 'user', id: actor.userId }, origin, transaction)
    })
  }

  /** 一份文档的恢复：整单只有这一行，回到原位置或空间的根目录。 */
  private async restoreDocument(entry: TrashEntryRow, documents: readonly TrashedDocumentRow[], transaction: Transaction): Promise<RestoredTrashEntry> {
    const documentId = documents[0]?.id
    if (documentId === undefined || documents.length !== 1)
      throw new Error(`一份文档的删除单元里有 ${documents.length} 份文档：${entry.id}`)
    const parent = await this.originParentOf(entry, transaction)
    const folderId = parent?.id ?? null
    await this.documents.restoreInEntry(entry.id, folderId, transaction)
    return { id: documentId, kind: 'document', title: entry.title, spaceId: entry.spaceId, folderId, movedToRoot: entry.originParentId !== null && folderId === null }
  }

  /**
   * 一个文件夹的恢复：整棵子树一起回到正常状态，层数按恢复后的位置重算；
   * 原位置不在时回到空间的根目录（spec §3）。里面的文档位置不变，仍在各自的文件夹下。
   *
   * 这里不再判断层数上限：删除不动父子关系与层数，移动整棵子树时已经判断过"整棵放得下"（FOLDER_MAX_DEPTH），
   * 而且回收站里的子孙跟着父辈一起移动、一起算层数（FoldersRepository.restoreInEntry 与 moveSubtree 同形），
   * 所以"原位置还在"时根的层数必然正好是 parent.depth + 1，层差为 0，永远超不了上限（审查 A2 的死分支）。
   */
  private async restoreFolder(entry: TrashEntryRow, transaction: Transaction): Promise<RestoredTrashEntry> {
    const root = rootFolderOf(entry.id, await this.folders.listInEntry(entry.id, transaction))
    const parent = await this.originParentOf(entry, transaction)
    const parentId = parent?.id ?? null
    const depth = parent === undefined ? 1 : parent.depth + 1
    await this.folders.restoreInEntry(entry.id, root.id, parentId, depth - root.depth, transaction)
    // 位置不变（undefined）：它们仍在子树里各自的文件夹下，跟着文件夹一起回到正常状态
    await this.documents.restoreInEntry(entry.id, undefined, transaction)
    return { id: root.id, kind: 'folder', title: entry.title, spaceId: entry.spaceId, folderId: parentId, movedToRoot: entry.originParentId !== null && parentId === null }
  }

  /**
   * 锁住回收站行并重新判断：这期间它可能被恢复或永久删除（都看到它已经不在，NOT_FOUND，spec §7），
   * 空间可能被归档、自己可能被移出空间；取锁之前刚好有一次跨空间移动提交时，这把树锁保护不到它，同样按"没找到"回答。
   * 最后这一条由 tests/integration 的"等树锁期间删除单元被搬到别的空间：恢复 404，文档仍在回收站里"覆盖（审查 A 建议 8），
   * 别处的同一条范式（删除文档、删除文件夹、文件夹与文档的改名和移动）写法相同，由这一条用例代表。
   */
  private async lockedEntry(
    actor: Actor,
    entryId: string,
    spaceId: string,
    operations: readonly TrashOperation[],
    transaction: Transaction,
  ): Promise<TrashEntryRow> {
    const { entry } = await requireTrashEntry(this.policy, actor, await this.entries.lockById(entryId, transaction), operations, transaction)
    if (entry.spaceId !== spaceId)
      throw new AppError('NOT_FOUND')
    return entry
  }

  /**
   * 原来的父文件夹：还在、状态正常才算（否则恢复回到空间的根目录，spec §3）。
   *
   * 它还在、状态正常时一定与删除单元在同一个空间里；不在是数据不一致，按意外错误处理（不变量失败，M2-P6 复核 B 的 G-5）。
   * 为什么一定在同一个空间：被删的对象删除之后仍指着原来的父文件夹（文档的 folder_id、文件夹的 parent_id 都不变，
   * 删除单元的 origin_parent_id 就是它），回收站里的对象自己不能移动，也不在停用者文档的转移之列；
   * 只有父文件夹跨空间移动时它才会换空间，而那时它在父文件夹的子树里，连同它的删除单元一起搬走
   * （FoldersService.toSpace：子树里的文档不按状态过滤，删除单元按子树里的行找）。
   * 父文件夹自己进了回收站或被永久删除时 findById 找不到它，走的是回到根目录那一支
   */
  private async originParentOf(entry: TrashEntryRow, transaction: Transaction): Promise<FolderRow | undefined> {
    if (entry.originParentId === null)
      return undefined
    const parent = await this.folders.findById(entry.originParentId, transaction)
    if (parent !== undefined && parent.spaceId !== entry.spaceId)
      throw new Error(`删除单元与它原来的父文件夹不在同一个空间里：${entry.id}`)
    return parent
  }

  /** 列表里的一条：原位置的名称由一次批量查询给出，份数由一条按删除单元 id 的计数给出。 */
  private toSummary(
    row: TrashEntryRow,
    access: SpaceContentAccess,
    userId: string,
    documentCount: number,
    parents: ReadonlyMap<string, string>,
  ): TrashEntrySummary {
    const parentName = row.originParentId === null ? null : parents.get(row.originParentId) ?? null
    return {
      id: row.id,
      spaceId: row.spaceId,
      kind: row.kind,
      title: row.title,
      deletedBy: row.deletedBy,
      deletedAt: row.deletedAt,
      expiresAt: row.expiresAt,
      // 原位置：父文件夹为空说明原来就在空间的根目录下（available），父文件夹不在了说明原位置已不存在
      origin: { parentId: row.originParentId, parentName, available: row.originParentId === null || parentName !== null },
      documentCount,
      permissions: trashPermissionsOf(access.role, row.deletedBy, userId),
    }
  }

  /**
   * 动作与明细一起给出：明细按动作的严格结构（contracts 的 auditDetailsSchema），只有 id、份数与标志，
   * 没有标题与名称（M2-P6 复核 M-1）；审计明细有字节上限，无界的数组会让整条写入失败（审查 A1）
   */
  private async record(
    audit: Extract<AuditActionDetailsInput, { action: TrashAuditAction }>,
    actor: TrashActor,
    target: { readonly type: 'document' | 'folder', readonly id: string },
    origin: AuditOrigin,
    transaction: Transaction,
  ): Promise<void> {
    await this.audit.record({ ...audit, actor, target, origin }, { transaction })
  }
}
