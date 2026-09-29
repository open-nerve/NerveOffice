import type { Folder, FolderListQuery, FolderListResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { AccessibleFolder, Actor, FolderOperation, SpaceContentAccess } from './document-access-policy.ts'
import type { FolderRow, SubtreeSummary } from './folders.repository.ts'
import { FOLDER_LIST_MAX_ITEMS, FOLDER_MAX_DEPTH } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { inIdOrder } from '../../shared/id-order.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { folderPermissionsOf } from './access-rules.ts'
import { DocumentAccessPolicy, requireCreateTarget, requireFolderContent, requireSpaceContent } from './document-access-policy.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { requireFolderIn } from './folder-location.ts'
import { toFolder } from './folder-views.ts'
import { FoldersRepository } from './folders.repository.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'
import { TrashEntriesRepository } from './trash-entries.repository.ts'
import { WriteAccessRevocation } from './write-access.ts'

/** 新建文件夹（已经过 contracts 的校验）。 */
export interface CreateFolderCommand {
  readonly spaceId: string
  /** 建在哪个文件夹下；没有时建在空间的根目录 */
  readonly parentId?: string | undefined
  readonly name: string
  readonly requestId: string
}

/** 改名或移动（已经过 contracts 的校验）：两项都没有时什么也不改。 */
export interface UpdateFolderCommand {
  readonly name?: string | undefined
  /** null 表示移到空间的根目录；undefined 表示不移动 */
  readonly parentId?: string | null | undefined
}

/** 连同子树移动到某个空间的某个位置（已经过 contracts 的校验）。 */
export interface MoveFolderCommand {
  readonly spaceId: string
  /** 目标空间里的父文件夹；没有时是那个空间的根目录 */
  readonly folderId?: string | undefined
}

/**
 * 空间里的文件夹（M2-P4 设计 §3.4）：列出一层、新建、改名、移动（同一个空间里，或者连同子树移到别的空间）。
 * 层数存在列里，新建与移动时在事务里算好并校验（最多 FOLDER_MAX_DEPTH 层），移动子树时整棵加上差值。
 * 结构性的改动都在事务的第一步取空间树的 advisory lock（SpaceTreeRepository），同一个空间里逐个执行；
 * 跨空间时按空间 id 排序取两把，再按同样的顺序取空间行，并在锁下重新判断一次（ADR-007 的锁顺序）。
 */
@Injectable()
export class FoldersService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly folders: FoldersRepository,
    private readonly documents: DocumentsRepository,
    private readonly trashEntries: TrashEntriesRepository,
    private readonly tree: SpaceTreeRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
    private readonly writeAccess: WriteAccessRevocation,
  ) {}

  /** 列出一层：parentId 省略表示空间的根目录。看不到这个空间与它不存在都是 NOT_FOUND。 */
  async list(actor: Actor, query: FolderListQuery): Promise<FolderListResponse> {
    const space = await requireSpaceContent(this.policy, actor, query.spaceId, 'view')
    const parent = query.parentId === undefined ? null : (await this.requireFolderIn(query.spaceId, query.parentId)).id
    const rows = await this.folders.listChildren(query.spaceId, parent)
    const permissions = folderPermissionsOf(space.role)
    return {
      items: rows.slice(0, FOLDER_LIST_MAX_ITEMS).map(row => toFolder(row, permissions)),
      truncated: rows.length > FOLDER_LIST_MAX_ITEMS,
    }
  }

  /**
   * 新建：要有在这个空间里新建的权限，父文件夹要在同一个空间里，层数不超过上限。
   * requestId 幂等：同一个请求重试只建一个（同一个文件夹里允许同名，看名字分辨不出重复的新建）。
   */
  async create(actor: Actor, command: CreateFolderCommand, origin: AuditOrigin): Promise<Folder> {
    return this.transactions.run(async (transaction) => {
      // 先判断（不加锁）：看不到与不能新建的请求不取任何锁
      await requireSpaceContent(this.policy, actor, command.spaceId, 'createFolders', transaction)
      // 空间树的结构性改动串行（设计 §3.4 第 2 条）：这把锁排在空间行之前
      await this.tree.lock([command.spaceId], transaction)
      // 再取空间的共享锁、锁下再判断：与归档、移出成员（空间行的 FOR NO KEY UPDATE）互斥，它们提交之后的新建一定被拒绝
      await this.spaces.holdSpace(command.spaceId, transaction)
      const space = await requireSpaceContent(this.policy, actor, command.spaceId, 'createFolders', transaction)
      const permissions = folderPermissionsOf(space.role)

      const previous = await this.folders.findByRequestId(command.requestId, transaction)
      if (previous !== undefined)
        return toFolder(this.replay(actor, command, previous), permissions)

      const parent = command.parentId === undefined ? undefined : await this.requireFolderIn(command.spaceId, command.parentId, transaction)
      const depth = parent === undefined ? 1 : parent.depth + 1
      if (depth > FOLDER_MAX_DEPTH)
        throw new AppError('FOLDER_DEPTH_EXCEEDED')

      const folder = await this.folders.insert({
        spaceId: command.spaceId,
        parentId: parent?.id ?? null,
        name: command.name,
        createdBy: actor.userId,
        depth,
        requestId: command.requestId,
      }, transaction)
      // 同一个 requestId 同时被别的空间里的新建用掉了（空间树的锁只让同一个空间里的排队）
      if (folder === undefined)
        throw new AppError('REQUEST_ID_CONFLICT')
      await this.audit.record({
        action: 'folders.created',
        actor: { type: 'user', id: actor.userId },
        target: { type: 'folder', id: folder.id },
        origin,
        details: { spaceId: folder.spaceId, parentId: folder.parentId, name: folder.name },
      }, { transaction })
      return toFolder(folder, permissions)
    })
  }

  /** 改名或在同一个空间里移动：要有编辑者及以上的角色；没有变化的那一项不改、不记审计。 */
  async update(actor: Actor, id: string, command: UpdateFolderCommand, origin: AuditOrigin): Promise<Folder> {
    return this.transactions.run(async (transaction) => {
      // 先判断（不加锁）：看不到与不能做的请求不取任何锁；看不到与不存在都是 NOT_FOUND
      const checked = await this.checkUpdate(actor, await this.folders.findById(id, transaction), command, transaction)
      await this.tree.lock([checked.folder.spaceId], transaction)
      await this.spaces.holdSpace(checked.folder.spaceId, transaction)
      // 锁下重新读、重新判断：这期间它可能被移动、被删，空间可能被归档，自己可能被移出空间
      const { folder, permissions } = await this.checkUpdate(actor, await this.folders.findById(id, transaction), command, transaction)
      // 树锁是按取锁之前读到的空间取的。跨空间移动会同时取来源与目标两把树锁，拿到锁之后它换不了空间；
      // 万一取锁之前刚好有一次跨空间移动提交了，这把锁就保护不到它——不在错的锁下改东西，按"没找到"回答，刷新后重试
      if (folder.spaceId !== checked.folder.spaceId)
        throw new AppError('NOT_FOUND')

      let current = folder
      if (command.name !== undefined && command.name !== current.name) {
        const from = current.name
        current = await this.folders.rename(current.id, command.name, transaction)
        await this.record('folders.renamed', actor, current.id, origin, { spaceId: current.spaceId, from, to: current.name }, transaction)
      }
      if (command.parentId !== undefined && command.parentId !== current.parentId)
        current = await this.movedWithinSpace(actor, current, await this.parentIn(current.spaceId, command.parentId, transaction), origin, transaction)
      return toFolder(current, permissions)
    })
  }

  /**
   * 连同子树移动到某个空间的某个位置（M2-P4 设计 §3.2）：
   * - 目标是别的空间：要源空间的空间管理员角色 + 目标空间的新建权限（00 号计划书 §5.3）；整棵子树一起搬，
   *   里面的文档跟着换空间、写入代次加一，并在同一个事务里收回它们的写入权（§5.4：权限随之改变）；
   * - 目标就是现在所在的空间：与空间内移动同一条规则（编辑者及以上），代次不变——
   *   移动成功之后重试同一个请求因此是幂等的，不会白白递增代次（与移动文档一致）。
   */
  async move(actor: Actor, id: string, command: MoveFolderCommand, origin: AuditOrigin): Promise<Folder> {
    return this.transactions.run(async (transaction) => {
      // 先判断（不加锁）：看不到与不能做的请求不取任何锁；看不到与不存在都是 NOT_FOUND
      const checked = await this.checkMove(actor, await this.folders.findById(id, transaction), command, transaction)
      // 两个空间的树锁一起取（目标就是本空间时只有一把）：防成环的取锁顺序由 SpaceTreeRepository 一处负责，
      // 服务只把牵涉到的空间一起交给它；空间行在这里按同一个顺序（id）取，两个方向的跨空间移动同时发生时不成环
      const involved = [...new Set([checked.folder.spaceId, command.spaceId])]
      await this.tree.lock(involved, transaction)
      for (const spaceId of inIdOrder(involved))
        await this.spaces.holdSpace(spaceId, transaction)
      // 锁下重新读、重新判断：这期间它可能被删、被别人移走，空间可能被归档，自己可能被移出空间
      const { folder, target } = await this.checkMove(actor, await this.folders.findById(id, transaction), command, transaction)
      // 树锁是按取锁之前读到的空间取的：万一刚好有一次跨空间移动提交了，这把锁就保护不到它（与改名、空间内移动相同）
      if (folder.spaceId !== checked.folder.spaceId)
        throw new AppError('NOT_FOUND')

      const parent = await this.parentIn(command.spaceId, command.folderId ?? null, transaction)
      const permissions = folderPermissionsOf(target.role)
      // 目标就是现在所在的空间：与 PATCH 同一条路径，位置没有变化时什么也不改
      if (folder.spaceId === command.spaceId) {
        const parentId = parent?.id ?? null
        const current = parentId === folder.parentId ? folder : await this.movedWithinSpace(actor, folder, parent, origin, transaction)
        return toFolder(current, permissions)
      }
      return toFolder(await this.toSpace(actor, folder, command.spaceId, parent, origin, transaction), permissions)
    })
  }

  /** 判断这次改动要的权限：改名要改名的权限，移动要移动的权限，两项都给就两项都要（一条查询判断完）。 */
  private async checkUpdate(
    actor: Actor,
    folder: FolderRow | undefined,
    command: UpdateFolderCommand,
    transaction: Transaction,
  ): Promise<AccessibleFolder<FolderRow>> {
    const operations: FolderOperation[] = []
    if (command.name !== undefined)
      operations.push('rename')
    if (command.parentId !== undefined)
      operations.push('moveWithinSpace')
    // 两项都没有给时也判断一次：不存在与看不到执行同样的查询、给同样的响应
    return requireFolderContent(this.policy, actor, folder, operations, transaction)
  }

  /**
   * 判断移动要的权限：目标是别的空间时要源空间的空间管理员，还要目标空间的新建权限（目标已归档是 409）；
   * 目标就是现在所在的空间时只要编辑者及以上，不再判断一次目标空间（归档时上一步就拒绝了，403 说明空间已归档）。
   */
  private async checkMove(
    actor: Actor,
    folder: FolderRow | undefined,
    command: MoveFolderCommand,
    transaction: Transaction,
  ): Promise<AccessibleFolder<FolderRow> & { readonly target: SpaceContentAccess }> {
    const sameSpace = folder?.spaceId === command.spaceId
    const accessible = await requireFolderContent(this.policy, actor, folder, [sameSpace ? 'moveWithinSpace' : 'moveAcrossSpaces'], transaction)
    if (sameSpace)
      return { ...accessible, target: accessible.space }
    return { ...accessible, target: await requireCreateTarget(this.policy, actor, command.spaceId, transaction) }
  }

  /** 在同一个空间里换父文件夹（调用方已判断权限、已解析目标位置）：整棵子树的层数一起变，记审计。 */
  private async movedWithinSpace(
    actor: Actor,
    folder: FolderRow,
    parent: FolderRow | undefined,
    origin: AuditOrigin,
    transaction: Transaction,
  ): Promise<FolderRow> {
    const { root } = await this.movedSubtree(folder, parent, undefined, transaction)
    await this.recordMove(actor, folder, root, origin, undefined, transaction)
    return root
  }

  /**
   * 连同子树移到别的空间（调用方已锁住两个空间的树、已判断两边的权限与目标位置）：
   * 子树里的文件夹换空间与层数（一条 UPDATE），里面的文档换空间、写入代次加一、位置不变——
   * 它们仍在各自的父文件夹里，只有被移动的那个文件夹自己换父。
   * 同一个事务里收回这些文档上的写入权（M3 在这个入口里终止租约）。
   * 文档行在文件夹之后锁（锁顺序：文件夹行 → 文档行）：保存内容不取树锁，所以要真的锁住它们
   */
  private async toSpace(
    actor: Actor,
    folder: FolderRow,
    spaceId: string,
    parent: FolderRow | undefined,
    origin: AuditOrigin,
    transaction: Transaction,
  ): Promise<FolderRow> {
    const { root, subtree } = await this.movedSubtree(folder, parent, spaceId, transaction)
    const inFolders = await this.documents.lockInFolders(subtree.ids, folder.spaceId, transaction)
    const documentIds = inFolders.map(row => row.id)
    if (documentIds.length > 0) {
      // 位置不变（undefined）：它们仍在子树里各自的文件夹下，跟着文件夹一起到了新空间
      await this.documents.moveToSpace(documentIds, spaceId, undefined, transaction)
      await this.writeAccess.revoke({ kind: 'documents', documentIds }, transaction)
    }
    // 完全落在这棵子树里的删除单元跟着换空间（P4-S3 spec §6b）：子树里已经在回收站的东西一起搬走了，
    // 一个删除单元要么整体在子树里、要么整体不在，所以顺着子树里的行找到的单元就是要迁的那些
    const entryIds = [...new Set([
      ...inFolders.flatMap(row => row.trashEntryId ?? []),
      ...await this.folders.trashEntryIdsIn(subtree.ids, transaction),
    ])]
    await this.trashEntries.moveToSpace(entryIds, spaceId, transaction)
    await this.recordMove(actor, folder, root, origin, { folders: subtree.ids.length, documents: documentIds.length }, transaction)
    return root
  }

  /**
   * 整棵子树挪到 parent 下面（parent 为空表示空间的根目录），spaceId 给出时连所属空间一起换：
   * 目标的父文件夹不能在这棵子树里（否则成环），整棵子树移过去之后不能超过层数上限。
   * 跨空间时目标在别的空间里，不可能在这棵子树里，成环这一条自然不成立，照样判断一次，不分两条路
   */
  private async movedSubtree(
    folder: FolderRow,
    parent: FolderRow | undefined,
    spaceId: string | undefined,
    transaction: Transaction,
  ): Promise<{ readonly root: FolderRow, readonly subtree: SubtreeSummary }> {
    const depth = parent === undefined ? 1 : parent.depth + 1
    const delta = depth - folder.depth
    // 子树包含它自己：目标的父文件夹是它自己或它的子孙时都会成环
    const subtree = await this.folders.summarizeSubtree(folder.id, parent?.id ?? null, transaction)
    if (subtree.containsCandidate)
      throw new AppError('FOLDER_CYCLE')
    if (subtree.maxDepth + delta > FOLDER_MAX_DEPTH)
      throw new AppError('FOLDER_DEPTH_EXCEEDED')
    const root = await this.folders.moveSubtree({ rootId: folder.id, parentId: parent?.id ?? null, depthDelta: delta, spaceId }, transaction)
    return { root, subtree }
  }

  /** 移动的目标位置：null 表示空间的根目录，不必查询；给出文件夹时它要在这个空间里、状态正常。 */
  private async parentIn(spaceId: string, parentId: string | null, transaction?: Transaction): Promise<FolderRow | undefined> {
    return parentId === null ? undefined : this.requireFolderIn(spaceId, parentId, transaction)
  }

  /** 这个空间里正常状态的一个文件夹（父文件夹、要列出的那一层）：规则见 folder-location.ts。 */
  private async requireFolderIn(spaceId: string, folderId: string, transaction?: Transaction): Promise<FolderRow> {
    return requireFolderIn(this.folders, spaceId, folderId, transaction)
  }

  /**
   * 同一个 requestId 已经建过文件夹：是同一个人、同一次新建（同一个空间、同一个父文件夹、同一个名称），
   * 才返回那个文件夹；否则拒绝，不透露它的任何信息。
   * 按当前的行比较：建好之后改名或移动过，再重发同一个 requestId 会被当作另一个请求（重试只发生在几秒之内）
   */
  private replay(actor: Actor, command: CreateFolderCommand, previous: FolderRow): FolderRow {
    const same = previous.createdBy === actor.userId
      && previous.spaceId === command.spaceId
      && previous.parentId === (command.parentId ?? null)
      && previous.name === command.name
    if (!same)
      throw new AppError('REQUEST_ID_CONFLICT')
    return previous
  }

  /**
   * 移动的审计：原位置与目标位置都记下（空间与父文件夹各一对，与移动文档同一个形状），空间内移动时两个空间相同；
   * 跨空间时另记这次搬动的文件夹数与文档数（子树有多大，事后看得出来）。
   */
  private async recordMove(
    actor: Actor,
    before: FolderRow,
    moved: FolderRow,
    origin: AuditOrigin,
    counts: { readonly folders: number, readonly documents: number } | undefined,
    transaction: Transaction,
  ): Promise<void> {
    const location = { fromSpaceId: before.spaceId, fromParentId: before.parentId, toSpaceId: moved.spaceId, toParentId: moved.parentId }
    await this.record('folders.moved', actor, moved.id, origin, counts === undefined ? location : { ...location, ...counts }, transaction)
  }

  private async record(
    action: 'folders.renamed' | 'folders.moved',
    actor: Actor,
    folderId: string,
    origin: AuditOrigin,
    details: Readonly<Record<string, string | number | null>>,
    transaction: Transaction,
  ): Promise<void> {
    await this.audit.record({
      action,
      actor: { type: 'user', id: actor.userId },
      target: { type: 'folder', id: folderId },
      origin,
      details,
    }, { transaction })
  }
}
