import type { DocumentAccessVia, SearchQuery } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { SpaceFactsWithOwner } from '../spaces/index.ts'
import type { Actor } from './document-access-policy.ts'
import type { SearchHit } from './document-views.ts'
import type { SearchRow } from './documents.repository.ts'
import { SEARCH_PAGE_SIZE } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { SpacesService } from '../spaces/index.ts'
import { DocumentAccessPolicy } from './document-access-policy.ts'
import { toLocatedSpace, toSearchHit } from './document-views.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { folderPathsOf } from './folder-path.ts'
import { FoldersRepository } from './folders.repository.ts'
import { titleSearchPattern } from './title-search.ts'

/** 搜索的一页（所在空间的所有者的人名由 workspace 补上，见 SearchHit） */
export interface SearchPage {
  readonly items: SearchHit[]
  readonly nextCursor: string | null
}

/**
 * 按标题搜索我能访问的文档（M2-P4 设计 §3.4 第 5 条、§3.5，US-M2-12；M2-P5 设计 §3.4(2) 并上单独授权）。
 *
 * 范围只由仓储的 `accessible` 给出，两半都要：`{ spaceIds: 我能看到的空间, grantsOf: 我 }`，它自己只取正常状态的行。
 * 因此回收站里的不会出现，看不到的空间里没有分享给我的也不会出现——不另写一份过滤条件。
 * 每一行是凭空间角色还是凭授权看到的：在我能看到的空间里就是凭空间角色（与 documentAccessOf 同一条规则：有空间角色时途径是 space），
 * 否则必须是"凭授权命中"——这个标志由搜索的那一条语句给出（SearchRow.granted），不事后另读授权（两次读之间并发的取消分享，
 * 会让正常的搜索被判为越出范围）。两样都不是就是"可访问文档"的条件坏了：不变量失败（见 accessViaOf）。
 * 排序与分页与文档列表完全一致（`updated_at DESC, id DESC` 的 keyset），不做相关度排序。
 * 结果里带它在哪里：所在空间的 id、类型与名称（个人空间另带所有者的 id，人名由 workspace 补上），按本页的空间一次批量取齐；
 * 凭空间角色看到的另带从空间根目录到它所在文件夹的名称（一次批量查询，FoldersRepository.ancestorsOf）。
 * 凭授权命中的不给目录结构：不给文件夹，也不查它的路径（00 号计划书 §5.5）。
 * 每一条语句都在调用方（workspace）开的只读快照里（M2 Codex 评审 CX1）：原来先取"我能看到的空间"、再拿这份旧的集合去搜，
 * 两条语句之间被移出空间、随即在那里新建的文档会出现在结果里；现在空间的集合与搜到的行出自同一个快照。
 */
@Injectable()
export class DocumentSearchService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly folders: FoldersRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
  ) {}

  async search(actor: Actor, query: SearchQuery, transaction: Transaction): Promise<SearchPage> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')

    // 我能看到的空间（有空间角色的）：空间那一半的范围，也是判断一行凭什么看到的依据
    const spaceIds = (await this.policy.visibleSpaces(actor, transaction)).map(access => access.space.id)
    const visible = new Set(spaceIds)
    // 多取一条，判断还有没有下一页
    const rows = await this.documents.searchByTitle(
      { spaceIds, grantsOf: actor.userId },
      { limit: SEARCH_PAGE_SIZE + 1, after, titlePattern: titleSearchPattern(query.query) },
      transaction,
    )
    // 查出来的每一行（含多取的那一条）先核对不变量，再分页、输出：范围之外的行一条也不输出，
    // "还有没有下一页"也不会因为它们而成立
    const located = rows.map(row => ({ row, accessVia: accessViaOf(row, visible) }))
    const page = located.slice(0, SEARCH_PAGE_SIZE)
    // 本页的空间连同个人空间的所有者：一条语句按一批 id 取（凭授权命中的行在我看不到的空间里，visibleSpaces 里没有它们）
    const spaces = await this.spaces.accessFactsOfMany(actor.userId, page.map(({ row }) => row.spaceId), { transaction })
    // 本页凭空间角色看到的行用到的文件夹（去重）：一次批量取齐它们连同祖先的名称，拼路径在内存里做；凭授权命中的不查
    const folderIds = [...new Set(page.flatMap(({ row, accessVia }) => accessVia === 'space' && row.folderId !== null ? [row.folderId] : []))]
    const paths = folderPathsOf(await this.folders.ancestorsOf(folderIds, spaceIds, transaction))
    const last = page.at(-1)?.row
    return {
      items: page.map(({ row, accessVia }) => {
        const space = spaceOf(row, spaces)
        const folderPath = accessVia === 'space' && row.folderId !== null ? paths.get(row.folderId) ?? [] : []
        return toSearchHit(row, toLocatedSpace(space, space.ownerUserId), folderPath, accessVia)
      }),
      nextCursor: located.length > page.length && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
    }
  }
}

/**
 * 一行是凭什么看到的：在"我能看到的空间"里是 space（查询的空间那一半就是这同一份集合），否则一定是凭授权命中（同一条语句给出的标志）。
 * 两样都不是就是"可访问文档"的条件坏了：不静默丢掉（丢掉会掩盖仓储一层的回归，下一页的游标也会按丢掉之前的行算出来，
 * 透露范围之外的匹配存在与数量），按意外错误处理——整个请求失败（500），错误连同文档与空间的 id 记进请求日志，
 * 响应里没有看不到的空间的任何信息（M2-P4 设计 §3.5；M2-P6 复核 A 的 S3、B 的 G-3；M2-P5 设计 §3.4(2) 并上"凭授权命中"）
 */
function accessViaOf(row: SearchRow, visible: ReadonlySet<string>): DocumentAccessVia {
  if (visible.has(row.spaceId))
    return 'space'
  if (row.granted)
    return 'grant'
  throw new Error(`搜索结果里有可见范围之外的文档：文档 ${row.id}，空间 ${row.spaceId}`)
}

/** 一行所在的空间：文档的 space_id 有外键，按 id 取不到就是数据不一致，按意外错误处理 */
function spaceOf(row: SearchRow, spaces: ReadonlyMap<string, SpaceFactsWithOwner>): SpaceFactsWithOwner {
  const space = spaces.get(row.spaceId)
  if (space === undefined)
    throw new Error(`搜索结果里的文档所在的空间不存在：文档 ${row.id}，空间 ${row.spaceId}`)
  return space
}
