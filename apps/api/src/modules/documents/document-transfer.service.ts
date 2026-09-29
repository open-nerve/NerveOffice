import type { AdminUserDocumentListResponse } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import { ADMIN_PAGE_SIZE } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { DocumentsRepository } from './documents.repository.ts'

/**
 * 停用者文档的转移（M2-P2 设计 §3.8，US-M2-04）：系统管理员的操作，不经内容权限——授权是系统角色（调用方在锁里复核），
 * 而且这里不读内容：标题列表只给标题、类型与更新时间，转移只改所属空间与写入代次（00 号计划书 §5.4）。只由 admin 调用。
 */
@Injectable()
export class DocumentTransferService {
  constructor(private readonly documents: DocumentsRepository) {}

  /** 一个空间里正常状态的文档的标题，按更新时间从新到旧分页 */
  async titles(spaceId: string, cursor: string | undefined): Promise<AdminUserDocumentListResponse> {
    const after = cursor === undefined ? undefined : decodeTimeCursor(cursor)
    if (cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    // 与列表用同一个"可访问文档"的条件（正常状态、在这个空间里）；多取一条，判断还有没有下一页
    const rows = await this.documents.listAccessible({ spaceIds: [spaceId] }, ADMIN_PAGE_SIZE + 1, after)
    const page = rows.slice(0, ADMIN_PAGE_SIZE)
    const last = page.at(-1)
    return {
      items: page.map(row => ({ id: row.id, title: row.title, type: row.type, updatedAt: row.updatedAt.toISOString() })),
      nextCursor: rows.length > ADMIN_PAGE_SIZE && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
    }
  }

  /**
   * 整批转移：按 id 顺序锁住文档行，每一份都要还在来源空间里、状态正常，否则整批拒绝（TRANSFER_CONFLICT，
   * 例如另一位管理员刚转走了其中一份）；改所属空间，写入代次加一。返回转移了的文档 id（按 id 排序）
   */
  async transfer(documentIds: readonly string[], fromSpaceId: string, toSpaceId: string, transaction: Transaction): Promise<string[]> {
    const ids = [...new Set(documentIds.map(id => id.toLowerCase()))]
    const rows = await this.documents.lockForTransfer(ids, transaction)
    if (rows.length !== ids.length || rows.some(row => row.spaceId !== fromSpaceId || row.status !== 'active'))
      throw new AppError('TRANSFER_CONFLICT')
    await this.documents.moveToSpace(ids, toSpaceId, transaction)
    return rows.map(row => row.id)
  }
}
