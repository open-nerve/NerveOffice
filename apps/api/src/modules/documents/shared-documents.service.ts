import type { SharedListQuery } from '@nerve-office/contracts'
import type { Actor, LocatedAccess } from './document-access-policy.ts'
import type { SharedHit } from './document-views.ts'
import type { GrantedDocumentRow } from './documents.repository.ts'
import { SHARED_PAGE_SIZE } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { DocumentAccessPolicy } from './document-access-policy.ts'
import { toSharedHit } from './document-views.ts'
import { DocumentsRepository } from './documents.repository.ts'

/** "与我共享"的一页（所在空间的所有者的人名由 workspace 补上，见 SharedHit） */
export interface SharedPage {
  readonly items: SharedHit[]
  readonly nextCursor: string | null
}

/**
 * "与我共享"（M2-P5 设计 §3.4(4)，US-M2-10）：我有单独授权的全部文档，不论我在那个空间里有没有角色。
 * - 范围是"可访问文档"的授权那一半加正常状态（仓储的 listGranted 经 accessible，条件仍只在那一处）：回收站里的不出现；
 * - 排序与分页与文档列表一致（按更新时间的 keyset，每页 SHARED_PAGE_SIZE 条）；
 * - 每条的内容权限经访问策略的批量入口算（accessOfMany：空间事实按一批 id 取，再经 documentAccessOf），不在这里另算；
 *   授权角色与行出自同一条语句；
 * - 每条带所在的空间（团队空间的名称；个人空间的所有者，人名由 workspace 补上），不带文件夹：看不到空间的目录结构。
 */
@Injectable()
export class SharedDocumentsService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly policy: DocumentAccessPolicy,
  ) {}

  async list(actor: Actor, query: SharedListQuery): Promise<SharedPage> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    // 多取一条，判断还有没有下一页
    const rows = await this.documents.listGranted(actor.userId, { limit: SHARED_PAGE_SIZE + 1, after })
    const page = rows.slice(0, SHARED_PAGE_SIZE)
    const accesses = await this.policy.accessOfMany(actor.userId, page.map(row => ({ document: row, grant: row.grantRole ?? undefined })))
    const last = page.at(-1)
    return {
      items: page.map((row) => {
        const { access, ownerUserId } = accessOf(row, accesses)
        return toSharedHit(row, access, ownerUserId)
      }),
      nextCursor: rows.length > SHARED_PAGE_SIZE && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
    }
  }
}

/**
 * 一行上的访问：列出它的那一条语句里它有我的授权（条件就是授权那一半），授权至少给出查看者；文档的空间有外键。
 * 算不出访问就是数据不一致或条件坏了：不静默丢掉（下一页的游标会按丢掉之前的行算），按意外错误处理（500），只记 id
 */
function accessOf(row: GrantedDocumentRow, accesses: ReadonlyMap<string, LocatedAccess>): LocatedAccess {
  const located = accesses.get(row.id)
  if (located === undefined)
    throw new Error(`"与我共享"里的文档算不出访问：文档 ${row.id}，空间 ${row.spaceId}`)
  return located
}
