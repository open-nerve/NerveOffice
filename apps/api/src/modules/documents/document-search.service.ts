import type { SearchQuery, SearchResponse } from '@nerve-office/contracts'
import type { SpaceFacts } from '../spaces/index.ts'
import type { Actor } from './document-access-policy.ts'
import type { DocumentRow } from './documents.repository.ts'
import { SEARCH_PAGE_SIZE } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { DocumentAccessPolicy } from './document-access-policy.ts'
import { toSearchResult } from './document-views.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { folderPathsOf } from './folder-path.ts'
import { FoldersRepository } from './folders.repository.ts'
import { titleSearchPattern } from './title-search.ts'

/**
 * 按标题搜索我能访问的文档（M2-P4 设计 §3.4 第 5 条、§3.5，US-M2-12）。
 *
 * 范围只由仓储的 `accessible` 给出：`{ spaceIds: 我能看到的空间 }`，它自己只取正常状态的行。
 * 因此回收站里的不会出现，看不到的空间里的也不会出现——不另写一份过滤条件，P5 的单独授权并进同一处。
 * 排序与分页与文档列表完全一致（`updated_at DESC, id DESC` 的 keyset），不做相关度排序。
 * 结果里带它在哪里：所在空间的 id、类型与名称（都来自"我能看到的空间"这一份事实，看不到的空间的任何信息都不会出现），
 * 以及从空间根目录到它所在文件夹的名称——路径由一次批量查询取齐（FoldersRepository.ancestorsOf）。
 */
@Injectable()
export class DocumentSearchService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly folders: FoldersRepository,
    private readonly policy: DocumentAccessPolicy,
  ) {}

  async search(actor: Actor, query: SearchQuery): Promise<SearchResponse> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')

    // 我能看到的空间：范围与结果里的空间名都只认这一份，两者不会不一致
    const spaces = new Map((await this.policy.visibleSpaces(actor)).map(access => [access.space.id, access.space]))
    const spaceIds = [...spaces.keys()]
    // 多取一条，判断还有没有下一页
    const rows = await this.documents.searchByTitle(
      { spaceIds },
      { limit: SEARCH_PAGE_SIZE + 1, after, titlePattern: titleSearchPattern(query.query) },
    )
    // 查出来的每一行（含多取的那一条）先核对不变量，再分页、输出：范围之外的行一条也不输出，
    // "还有没有下一页"也不会因为它们而成立
    const located = rows.map(row => ({ row, space: visibleSpaceOf(row, spaces) }))
    const page = located.slice(0, SEARCH_PAGE_SIZE)
    // 本页用到的文件夹（去重）：一次批量取齐它们连同祖先的名称，拼路径在内存里做
    const folderIds = [...new Set(page.flatMap(({ row }) => row.folderId ?? []))]
    const paths = folderPathsOf(await this.folders.ancestorsOf(folderIds, spaceIds))
    const last = page.at(-1)?.row
    return {
      items: page.map(({ row, space }) => toSearchResult(row, space, row.folderId === null ? [] : paths.get(row.folderId) ?? [])),
      nextCursor: located.length > page.length && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
    }
  }
}

/**
 * 一行所在的空间：一定在"我能看到的空间"里——查询的范围就是这同一份空间集合（accessible 按它过滤），查出来的行不可能在别处。
 * 在别处就是"可访问文档"的条件坏了：不静默丢掉（丢掉会掩盖仓储一层的回归，下一页的游标也会按丢掉之前的行算出来，
 * 透露范围之外的匹配存在与数量），按意外错误处理——整个请求失败（500），错误连同文档与空间的 id 记进请求日志，
 * 响应里没有看不到的空间的任何信息（设计 §3.5；M2-P6 复核 A 的 S3、B 的 G-3）
 */
function visibleSpaceOf(row: DocumentRow, spaces: ReadonlyMap<string, SpaceFacts>): SpaceFacts {
  const space = spaces.get(row.spaceId)
  if (space === undefined)
    throw new Error(`搜索结果里有可见范围之外的文档：文档 ${row.id}，空间 ${row.spaceId}`)
  return space
}
