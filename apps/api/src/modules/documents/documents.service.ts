import type { DocumentDetail, DocumentListQuery, DocumentListResponse } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { Actor } from './document-access-policy.ts'
import { DOCUMENT_LIST_ALL_FOLDERS } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { DocumentAccessPolicy, requireAccess, requireSpaceContent } from './document-access-policy.ts'
import { toDetail, toSummary } from './document-views.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { folderIdIn } from './folder-location.ts'
import { FoldersRepository } from './folders.repository.ts'

/**
 * 文档的元数据（M1-P3 设计 §3.6，M2-P2 设计 §3.5）：按空间列出与读取。新建见 DocumentCreationService，内容与保存见 DocumentContentService。
 * 两个读接口都在只读快照里判断权限、读数据（M2 Codex 评审 CX1）
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly repository: DocumentsRepository,
    private readonly folders: FoldersRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
    private readonly transactions: TransactionRunner,
  ) {}

  /**
   * 一个空间里某个目录下的文档：看得到这个空间才行，看不到与不存在都是 NOT_FOUND。
   * 没有指定空间时是本人的个人空间（M1 兼容）；没有指定目录时是空间的根目录，folderId=all 是整个空间。
   */
  async list(actor: Actor, query: DocumentListQuery): Promise<DocumentListResponse> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    return this.transactions.readSnapshot(async (transaction) => {
      const spaceId = query.spaceId ?? await this.personalSpaceIdOf(actor.userId, transaction)
      await requireSpaceContent(this.policy, actor, spaceId, 'view', transaction)
      const folderId = await this.folderFilterOf(spaceId, query.folderId, transaction)
      // 多取一条，判断还有没有下一页。只要空间那一半：按空间列出的是这个空间里的文档，单独授权不给空间里的任何东西开口子，
      // 并上授权就会把别处分享给我的文档列进这个空间（M2-P5 设计 §3.4(2)）
      const rows = await this.repository.listAccessible({ spaceIds: [spaceId], grantsOf: undefined }, { limit: query.limit + 1, after, folderId }, transaction)
      const page = rows.slice(0, query.limit)
      const last = page.at(-1)
      return {
        items: page.map(toSummary),
        nextCursor: rows.length > query.limit && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
      }
    })
  }

  /** 没有读取权限与不存在返回同一个 NOT_FOUND（规范 §4，US-M1-08）。 */
  async get(userId: string, id: string): Promise<DocumentDetail> {
    return this.transactions.readSnapshot(async (transaction) => {
      const { document, access } = await requireAccess(this.policy, userId, await this.repository.findById(id, transaction), transaction)
      return toDetail(document, access, userId)
    })
  }

  /**
   * 把查询里的 folderId 换成仓储的目录条件：省略是空间的根目录（null），all 是不按目录过滤（undefined）。
   * 指定的文件夹不在这个空间里（不存在、在别的空间里、已经在回收站里）时 NOT_FOUND（folder-location.ts）。
   */
  private async folderFilterOf(spaceId: string, folderId: string | undefined, transaction: Transaction): Promise<string | null | undefined> {
    if (folderId === DOCUMENT_LIST_ALL_FOLDERS)
      return undefined
    return folderIdIn(this.folders, spaceId, folderId ?? null, transaction)
  }

  private async personalSpaceIdOf(userId: string, transaction: Transaction): Promise<string> {
    const space = await this.spaces.personalSpaceOf(userId, { transaction })
    // 个人空间随账户一起创建；没有说明数据不一致，按意外错误处理
    if (space === undefined)
      throw new Error(`账户没有个人空间：${userId}`)
    return space.id
  }
}
