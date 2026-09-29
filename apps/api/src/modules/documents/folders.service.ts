import type { Folder, FolderListQuery, FolderListResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { AccessibleFolder, Actor, FolderOperation } from './document-access-policy.ts'
import type { FolderRow } from './folders.repository.ts'
import { FOLDER_LIST_MAX_ITEMS, FOLDER_MAX_DEPTH } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { folderPermissionsOf } from './access-rules.ts'
import { DocumentAccessPolicy, requireFolderContent, requireSpaceContent } from './document-access-policy.ts'
import { requireFolderIn } from './folder-location.ts'
import { toFolder } from './folder-views.ts'
import { FoldersRepository } from './folders.repository.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'

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

/**
 * 空间里的文件夹（M2-P4 设计 §3.4）：列出一层、新建、改名、同一个空间里移动。
 * 层数存在列里，新建与移动时在事务里算好并校验（最多 FOLDER_MAX_DEPTH 层），移动子树时整棵加上差值。
 * 结构性的改动都在事务的第一步取空间树的 advisory lock（SpaceTreeRepository），同一个空间里逐个执行。
 */
@Injectable()
export class FoldersService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly folders: FoldersRepository,
    private readonly tree: SpaceTreeRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
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
      // 树锁是按取锁之前读到的空间取的。跨空间移动（S2）会同时取来源与目标两把树锁，拿到锁之后它换不了空间；
      // 万一取锁之前刚好有一次跨空间移动提交了，这把锁就保护不到它——不在错的锁下改东西，按"没找到"回答，刷新后重试
      if (folder.spaceId !== checked.folder.spaceId)
        throw new AppError('NOT_FOUND')

      let current = folder
      if (command.name !== undefined && command.name !== current.name) {
        const from = current.name
        current = await this.folders.rename(current.id, command.name, transaction)
        await this.record('folders.renamed', actor, current, origin, { from, to: current.name }, transaction)
      }
      if (command.parentId !== undefined && command.parentId !== current.parentId) {
        const from = current.parentId
        current = await this.moveWithinSpace(current, command.parentId, transaction)
        await this.record('folders.moved', actor, current, origin, { from, to: current.parentId }, transaction)
      }
      return toFolder(current, permissions)
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
   * 移到同一个空间里的另一个位置（parentId 为 null 表示空间的根目录）：
   * 目标的父文件夹要在同一个空间里、不能在这棵子树里（否则成环），整棵子树移过去之后不能超过层数上限。
   */
  private async moveWithinSpace(folder: FolderRow, parentId: string | null, transaction: Transaction): Promise<FolderRow> {
    const parent = parentId === null ? undefined : await this.requireFolderIn(folder.spaceId, parentId, transaction)
    const depth = parent === undefined ? 1 : parent.depth + 1
    const delta = depth - folder.depth
    // 子树包含它自己：目标的父文件夹是它自己或它的子孙时都会成环
    const subtree = await this.folders.summarizeSubtree(folder.id, parent?.id ?? null, transaction)
    if (subtree.containsCandidate)
      throw new AppError('FOLDER_CYCLE')
    if (subtree.maxDepth + delta > FOLDER_MAX_DEPTH)
      throw new AppError('FOLDER_DEPTH_EXCEEDED')
    return this.folders.moveSubtree(folder.id, parent?.id ?? null, delta, transaction)
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

  private async record(
    action: 'folders.renamed' | 'folders.moved',
    actor: Actor,
    folder: FolderRow,
    origin: AuditOrigin,
    details: Readonly<Record<string, unknown>>,
    transaction: Transaction,
  ): Promise<void> {
    await this.audit.record({
      action,
      actor: { type: 'user', id: actor.userId },
      target: { type: 'folder', id: folder.id },
      origin,
      details: { spaceId: folder.spaceId, ...details },
    }, { transaction })
  }
}
