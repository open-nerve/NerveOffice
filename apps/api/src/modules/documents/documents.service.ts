import type { DocumentDetail, DocumentListQuery, DocumentListResponse, DocumentSummary } from '@nerve-office/contracts'
import type { DocumentRow } from './documents.repository.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { SpacesService } from '../spaces/index.ts'
import { DocumentAccessPolicy } from './document-access-policy.ts'
import { decodeCursor, encodeCursor } from './document-cursor.ts'
import { DocumentsRepository } from './documents.repository.ts'

function toSummary(row: DocumentRow): DocumentSummary {
  return { id: row.id, title: row.title, type: row.type, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

/** 文档的元数据（P3 设计 §3.6）：列表与读取。新建、内容与保存在 P4。 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly repository: DocumentsRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
  ) {}

  /** 当前用户个人空间里的文档（M2 加上团队空间与"与我共享"时，改为按参数指定空间）。 */
  async listPersonal(userId: string, query: DocumentListQuery): Promise<DocumentListResponse> {
    const space = await this.spaces.personalSpaceOf(userId)
    // 个人空间随账户一起创建；没有说明数据不一致，按意外错误处理
    if (space === undefined)
      throw new Error(`账户没有个人空间：${userId}`)
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    // 多取一条，判断还有没有下一页
    const rows = await this.repository.listInSpace(space.id, query.limit + 1, after)
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toSummary),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor({ updatedAt: last.position, id: last.id }) : null,
    }
  }

  /** 没有读取权限与不存在返回同一个 NOT_FOUND（规范 §4，US-M1-08）。 */
  async get(userId: string, id: string): Promise<DocumentDetail> {
    const row = await this.repository.findById(id)
    const access = row === undefined ? undefined : await this.policy.accessOf(userId, row)
    if (row === undefined || access === undefined)
      throw new AppError('NOT_FOUND')
    return { ...toSummary(row), spaceId: row.spaceId, permissions: { canEdit: access !== 'viewer' } }
  }
}
