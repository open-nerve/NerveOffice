import type { AdminUserDocumentListResponse } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import { ADMIN_PAGE_SIZE } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { WriteAccessRevocation } from './write-access.ts'

/**
 * 停用者文档的转移（M2-P2 设计 §3.8，US-M2-04）：系统管理员的操作，不经内容权限——授权是系统角色（调用方在锁里复核），
 * 而且这里不读内容：标题列表只给标题、类型与更新时间，转移只改所属空间与写入代次（00 号计划书 §5.4）。只由 admin 调用。
 */
@Injectable()
export class DocumentTransferService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly writeAccess: WriteAccessRevocation,
  ) {}

  /** 一个空间里正常状态的文档的标题，按更新时间从新到旧分页 */
  async titles(spaceId: string, cursor: string | undefined): Promise<AdminUserDocumentListResponse> {
    const after = cursor === undefined ? undefined : decodeTimeCursor(cursor)
    if (cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    // 与列表用同一个"可访问文档"的条件（在这个空间里；accessible 只取正常状态的行，所以回收站里的文档不列出、
    // 也不转移，M2-P4 设计 §3.4 第 1 条）；不按目录过滤：整个空间里的文档都要列出来。多取一条，判断还有没有下一页
    const rows = await this.documents.listAccessible({ spaceIds: [spaceId] }, { limit: ADMIN_PAGE_SIZE + 1, after })
    const page = rows.slice(0, ADMIN_PAGE_SIZE)
    const last = page.at(-1)
    return {
      items: page.map(row => ({ id: row.id, title: row.title, type: row.type, updatedAt: row.updatedAt.toISOString() })),
      nextCursor: rows.length > ADMIN_PAGE_SIZE && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
    }
  }

  /**
   * 整批转移：按 id 顺序锁住还在来源空间里、状态正常的文档（与标题列表同一个条件），少了一份就整批拒绝（TRANSFER_CONFLICT，
   * 例如另一位管理员刚转走了其中一份）；改所属空间，写入代次加一。返回转移了的文档 id（按 id 排序）。
   * 目标位置是目标空间的根目录（null）：文件夹属于某一个空间，转过去之后不能再留在来源空间的文件夹里（M2-P4）。
   * 转移是跨空间搬文档，谁能写随之改变：与跨空间移动一样，在同一个事务里经收回写入权的入口收回这些文档上的写入权
   * （00 号计划书 §5.4；M3 在这个入口里终止租约，M2-P6 复核 A 的 G2、B 的 S-5）。
   *
   * 这是唯一不取空间树锁的跨空间操作（M2-P6 复核 A 的 G-5）。不取也是安全的：树锁保护的是子树的形状（文件夹、删除单元与挂在
   * 它们下面的行），而转移不改任何一棵子树——只搬来源空间里正常状态的文档（锁下按"还在来源空间、状态正常"重新筛），
   * 落在目标空间的根目录（不进任何文件夹），不碰文件夹行与回收站行（"文件夹行与回收站行只在持有树锁时改动"这条不变量照样成立，
   * 见 SpaceTreeRepository）。与两边空间里并发的结构改动只在文档行上相遇，双方都按 id 顺序锁文档行：先到的做完，后到的锁下重新判断——
   * 结构改动锁的是锁下仍在它的子树里、仍在这个空间的文档（转走的文档已经不在任何文件夹里，不算它的），
   * 转移按上面的条件重新筛（已经进了回收站或被转走的，少了一份就整批拒绝）。
   * 回收站里的文档不转移：它们挂在删除单元下，搬走会把删除单元拆散在两个空间
   */
  async transfer(documentIds: readonly string[], fromSpaceId: string, toSpaceId: string, transaction: Transaction): Promise<string[]> {
    // id 已由契约统一成小写（M2-P2 审查 A1），契约也已拒绝重复；这里再去重，"锁住的份数对得上"的判断才不依赖调用方
    const ids = [...new Set(documentIds)]
    const locked = await this.documents.lockForTransfer(ids, fromSpaceId, transaction)
    if (locked.length !== ids.length)
      throw new AppError('TRANSFER_CONFLICT')
    await this.documents.moveToSpace(locked, toSpaceId, null, transaction)
    await this.writeAccess.revoke({ kind: 'documents', documentIds: locked }, transaction)
    return locked
  }
}
