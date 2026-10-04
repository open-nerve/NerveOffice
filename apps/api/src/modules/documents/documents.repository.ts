import type { DocumentProfile, DocumentStatus, DocumentType, GrantRole, PlatformFormatVersion } from '@nerve-office/contracts'
import type { SQL } from 'drizzle-orm'
import type { TimeCursor } from '../../shared/time-cursor.ts'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, isNull, ne, or, sql } from 'drizzle-orm'
import { documents } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf, inIdArray, keysetPosition } from '../database/index.ts'
import { grantedTo, grantRoleOf } from './document-grants.repository.ts'
import { TITLE_SEARCH_ESCAPE } from './title-search.ts'

export interface DocumentRow {
  readonly id: string
  readonly spaceId: string
  /** 所在的文件夹；在空间的根目录下时为空（M2-P4） */
  readonly folderId: string | null
  readonly type: DocumentType
  readonly title: string
  /** 创建人：删除的权限按它判断（编辑者只能删自己创建的，P4-S3 spec §2） */
  readonly createdBy: string
  readonly createdAt: Date
  readonly updatedAt: Date
  /** 游标用的更新时间：数据库算出的 UTC 文本，保留微秒 */
  readonly position: string
  readonly revision: number
  readonly unitId: string
  readonly profile: DocumentProfile
  readonly formatVersion: number
  /**
   * 写入代次（M2-P2，00 号计划书 §6.4）：编辑租约的有效条件按它判断（M3-P1 设计 §3.4.1 第 3 条）——租约的那一代不是它就过时。
   * 申请编辑权与收回写入权给它加一（advanceWriteEpoch），删除、跨空间移动与转移也加一；不进任何响应
   */
  readonly writeEpoch: number
}

/** 新建文档要写的列：修订号从 1 开始，状态为正常，时间取数据库的当前时间。 */
export interface NewDocument {
  readonly spaceId: string
  /** 建在哪个文件夹里；null 表示空间的根目录（M2-P4） */
  readonly folderId: string | null
  readonly type: DocumentType
  readonly title: string
  readonly createdBy: string
  readonly unitId: string
  readonly profile: DocumentProfile
  readonly formatVersion: PlatformFormatVersion
  readonly sdkVersion: string
}

/**
 * "可访问文档"的范围（M2-P2 设计 §3.5，M2-P4 设计 §3.4 第 1 条，M2-P5 设计 §3.4(2)）：要哪几半，由调用方按访问策略给出。
 * - 空间那一半：调用者有空间角色的空间（spaceIds；空数组表示不要这一半）；
 * - 授权那一半：这个人有单独授权的文档（grantsOf；undefined 表示不要这一半）。
 * grantsOf 是必填的键（可以是 undefined）：每个调用方都得写明要不要授权那一半——按空间列出、转移的标题列表与锁只要空间那一半，
 * 并上授权就会把别处的文档列进这个空间（M2-P5 设计 §7 的第一条风险；回收站的列表本来就不经这里）。
 * 状态不是参数，见下面的 accessible()。目录与关键词也不进这里，是各自查询自己的条件（M2-P4 设计 §7 的取舍）。
 */
export interface AccessibleScope {
  readonly spaceIds: readonly string[]
  readonly grantsOf: string | undefined
}

/** 列出可访问文档的条件与分页。 */
export interface ListOptions {
  readonly limit: number
  /** 上一页最后一条的位置（keyset） */
  readonly after?: TimeCursor | undefined
  /** 按目录过滤：省略（undefined）表示不按目录过滤，null 表示空间的根目录，字符串表示某个文件夹 */
  readonly folderId?: string | null | undefined
}

/** 只要授权那一半时的分页（"与我共享"）：排序与分页与列表一样 */
export interface PageOptions {
  readonly limit: number
  /** 上一页最后一条的位置（keyset） */
  readonly after?: TimeCursor | undefined
}

/**
 * 搜索结果的一行：granted 是"这个人在这份文档上有单独授权"，与行出自同一条语句（与"可访问文档"授权那一半同一个条件）。
 * 搜索据此判断一行是不是凭授权命中——不事后另读一次授权：两次读之间并发的取消分享，会让正常的结果被判为越出范围（M2-P5 设计 §3.4(2)）。
 * 不要授权那一半时恒为假
 */
export interface SearchRow extends DocumentRow {
  readonly granted: boolean
}

/** "与我共享"的一行：这个人在这份文档上的授权角色，与行出自同一条语句（同一个快照，M2-P5 设计 §3.4(4)） */
export interface GrantedDocumentRow extends DocumentRow {
  /** 条件就是"有授权"，同一条语句里不会为空；类型上仍可为空（标量子查询），调用方按没有授权处理 */
  readonly grantRole: GrantRole | null
}

/** 按标题搜索的条件与分页（M2-P4 设计 §3.4 第 5 条）：排序与分页与列表一样，多一个标题的条件。 */
export interface SearchOptions {
  readonly limit: number
  /** 上一页最后一条的位置（keyset） */
  readonly after?: TimeCursor | undefined
  /** 已经转义好、前后带通配符的 LIKE 模式（title-search.ts） */
  readonly titlePattern: string
}

/** 一份文档与它所属的删除单元（正常状态时为空）：跨空间移动、删除与永久删除都要顺着它找到删除单元。 */
export interface TrashedDocumentRow {
  readonly id: string
  readonly trashEntryId: string | null
}

/** 复制出来的文档要写的列：其余的列（类型、unitId、档案、格式版本、写入时的 SDK 版本）由数据库从源文档原样复制。 */
export interface CopiedDocument {
  readonly spaceId: string
  readonly folderId: string | null
  readonly title: string
  readonly createdBy: string
}

const d = documents
const COLUMNS = {
  id: d.id,
  spaceId: d.spaceId,
  folderId: d.folderId,
  type: d.type,
  title: d.title,
  createdBy: d.createdBy,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  position: keysetPosition(d.updatedAt),
  revision: d.revision,
  unitId: d.unitId,
  profile: d.profile,
  formatVersion: d.formatVersion,
  writeEpoch: d.writeEpoch,
}

/**
 * "可访问文档"的条件：列表、搜索、计数、停用者文档的转移、"与我共享"都经这一处，不各写各的过滤条件（M2 总设计 §6.1）。
 * `status = 'active' AND (space_id = ANY(…) OR EXISTS 授权)`，每一半只在调用方要它时才出现（见 AccessibleScope）：
 * - 只要授权那一半时（"与我共享"）**不带恒假的空间条件**（M2-P5 S3）：`space_id = ANY('{}') OR EXISTS …` 里的 OR 让规划器没法
 *   把 EXISTS 变成半连接，只能扫整张文档表、逐行判断授权；只剩 EXISTS 时查询从 document_grants 的 (user_id) 索引出发
 *   （集成测试 documents/shared-plan.test.ts 用 EXPLAIN 核对）；
 * - 两半都不要时恒为假（什么也查不出），不能因为没有条件就变成"全部正常状态的文档"。
 * **只取正常状态的行**：回收站的列表从 trash_entries 出（TrashService.list），不走这里，所以没有"状态"这一维；
 * 回收站里的文档即使有授权也不出现。授权那一半的条件由 DocumentGrantsRepository 给出（grantedTo），这里只组合
 */
function accessible(scope: AccessibleScope): SQL | undefined {
  const halves = [
    ...(scope.spaceIds.length > 0 ? [inIdArray(d.spaceId, scope.spaceIds)] : []),
    ...(scope.grantsOf === undefined ? [] : [grantedTo(d.id, scope.grantsOf)]),
  ]
  return and(eq(d.status, 'active'), halves.length === 0 ? sql`false` : or(...halves))
}

/** keyset 分页：上一页最后一条之后（按更新时间从新到旧、同一时间按 id），列表、搜索与"与我共享"同一个条件 */
function afterPosition(after: TimeCursor | undefined): SQL | undefined {
  return after === undefined ? undefined : sql`(${d.updatedAt}, ${d.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
}

/** 目录的过滤（见 ListOptions.folderId）：不进 accessible，是列表自己的条件。 */
function inFolder(folderId: string | null | undefined): SQL | undefined {
  if (folderId === undefined)
    return undefined
  return folderId === null ? isNull(d.folderId) : eq(d.folderId, folderId)
}

/**
 * documents 表的读写在这里（规范 §1.2）。一处例外：读取内容时修订号要与内容一起读，那条联表的语句在同一模块的 document-contents.repository.ts。
 * "可访问文档"的授权那一半是 document_grants 上的 EXISTS 子查询，条件由 DocumentGrantsRepository 给出（M2-P5）
 */
@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 可访问的文档，按更新时间从新到旧；after 是上一页最后一条的位置（keyset）。 */
  async listAccessible(scope: AccessibleScope, options: ListOptions, transaction?: Transaction): Promise<DocumentRow[]> {
    return executorOf(this.db, transaction)
      .select(COLUMNS)
      .from(d)
      .where(and(accessible(scope), inFolder(options.folderId), afterPosition(options.after)))
      .orderBy(desc(d.updatedAt), desc(d.id))
      .limit(options.limit)
  }

  /**
   * "与我共享"（M2-P5 设计 §3.4(4)）：这个人有单独授权的、正常状态的文档——只要"可访问文档"的授权那一半（条件仍只在 accessible），
   * 不论他在那个空间里有没有角色；排序与分页与文档列表一致。每行带他在这份文档上的授权角色（同一条语句），
   * 内容权限由访问策略的批量入口按它与空间事实算（accessOfMany），不在这里算
   */
  async listGranted(userId: string, options: PageOptions, transaction?: Transaction): Promise<GrantedDocumentRow[]> {
    return executorOf(this.db, transaction)
      .select({ ...COLUMNS, grantRole: grantRoleOf(d.id, userId) })
      .from(d)
      .where(and(accessible({ spaceIds: [], grantsOf: userId }), afterPosition(options.after)))
      .orderBy(desc(d.updatedAt), desc(d.id))
      .limit(options.limit)
  }

  /**
   * 标题里包含关键词的可访问文档，排序与分页与列表完全一致（M2-P4 设计 §3.4 第 5 条）。
   * 范围与状态仍然只由 accessible 给出（回收站里的因此不会出现，P5 的单独授权也只改那一处）；每行另带 granted（见 SearchRow）；
   * 大小写不敏感由两边一起 lower() 做；关键词里的 `\`、`%`、`_` 由调用方转义好，这里显式写出配套的 ESCAPE。
   * 本版不建 pg_trgm 索引（设计 §3.4 第 5 条已登记延期项，M7 压测时复核）
   */
  async searchByTitle(scope: AccessibleScope, options: SearchOptions, transaction?: Transaction): Promise<SearchRow[]> {
    return executorOf(this.db, transaction)
      .select({ ...COLUMNS, granted: scope.grantsOf === undefined ? sql<boolean>`false` : grantedTo(d.id, scope.grantsOf) })
      .from(d)
      .where(and(
        accessible(scope),
        sql`lower(${d.title}) LIKE lower(${options.titlePattern}) ESCAPE ${TITLE_SEARCH_ESCAPE}`,
        afterPosition(options.after),
      ))
      .orderBy(desc(d.updatedAt), desc(d.id))
      .limit(options.limit)
  }

  async findById(id: string, transaction?: Transaction): Promise<DocumentRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(d).where(and(eq(d.id, id), eq(d.status, 'active')))
    return row
  }

  /** 锁住文档行（FOR UPDATE）：同一份文档的保存按到达的顺序逐个执行，修订号的判断与加一之间不会插进别的保存。 */
  async lockById(id: string, transaction: Transaction): Promise<DocumentRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(d).where(and(eq(d.id, id), eq(d.status, 'active'))).for('update')
    return row
  }

  /**
   * 以共享锁持住文档行（FOR SHARE）再读：复制的源文档用（M2-P6 复核 A 的 S1）。与保存、改名、移动、删除、转移
   * （都取 FOR UPDATE）互斥：锁下读到的就是复制出去的那一版，复制提交之前它不会被改写、移走或删掉；
   * 几次复制之间不互斥。等锁期间它进了回收站或被永久删除时返回 undefined
   */
  async holdById(id: string, transaction: Transaction): Promise<DocumentRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(d).where(and(eq(d.id, id), eq(d.status, 'active'))).for('share')
    return row
  }

  /**
   * 按 id 顺序锁住要转移的文档（FOR UPDATE，与保存相同）：两次转移、转移与保存都按同一个顺序取锁，互相等待时不成环。
   * 只锁来源空间里的可访问文档（与标题列表同一个条件）：请求里夹带的别处的文档不被锁住（M2-P2 审查 A4）；
   * 等锁期间被别人转走的行，拿到锁之后按新的内容重新判断，不再返回。返回锁住的 id（按 id 排序）。
   * 只转正常状态的文档，这一条由 accessible 保证（M2-P4 设计 §3.4 第 1 条）：停用者回收站里的文档留在原处，
   * 30 天后自动清除——系统管理员没有内容权限，也不该替别人恢复；不按目录过滤：整个空间里的文档都要转走
   */
  async lockForTransfer(ids: readonly string[], fromSpaceId: string, transaction: Transaction): Promise<string[]> {
    const rows = await executorOf(this.db, transaction)
      .select({ id: d.id })
      .from(d)
      // 只要空间那一半：转移搬的是来源空间里的文档，与谁有授权无关（授权跟着文档走，M2-P5 设计 §3.3）
      .where(and(inIdArray(d.id, ids), accessible({ spaceIds: [fromSpaceId], grantsOf: undefined })))
      .orderBy(asc(d.id))
      .for('update')
    return rows.map(row => row.id)
  }

  /**
   * 按 id 顺序锁住这些文件夹里的文档（FOR UPDATE，与保存、转移相同的顺序）：
   * 文件夹跨空间移动时连它们一起搬，删除文件夹时整棵子树一起进回收站，永久删除时一起清掉。
   * state 省略时**不按状态过滤**（与展开文件夹子树一致，M2-P4 设计 §3.4）：回收站里的文档也跟着所在的文件夹走，
   * 否则它的 folder_id 会指到别的空间里的文件夹，删除单元也会被拆散在两个空间里；
   * state 为 'active' 时只取正常状态的——删除文件夹只把它们并进这次的删除单元，早先删过的留在原来的单元里（P4-S3 spec §1）。
   * 另加的 `space_id = spaceId` 是**纯冗余的防御**，不是正确性的必要条件：文档一定与它所在的文件夹在同一个空间里
   * （跨空间移动时两者在同一个事务里一起改），所以按子树的文件夹 id 找出来的行本来就都在这个空间。
   * 万一哪一行不是这样（数据不一致），它挡住那一行，不把别处的行卷进这次的删除单元（审查 A 的注释订正）
   */
  async lockInFolders(folderIds: readonly string[], spaceId: string, transaction: Transaction, state?: DocumentStatus): Promise<TrashedDocumentRow[]> {
    if (folderIds.length === 0)
      return []
    return executorOf(this.db, transaction)
      .select({ id: d.id, trashEntryId: d.trashEntryId })
      .from(d)
      .where(and(
        inIdArray(d.folderId, folderIds),
        eq(d.spaceId, spaceId),
        state === undefined ? undefined : eq(d.status, state),
      ))
      .orderBy(asc(d.id))
      .for('update')
  }

  /**
   * 按 id 顺序锁住属于这些删除单元的文档（FOR UPDATE）：恢复与永久删除按删除单元取出它的全部文档。
   * 一份文档的删除单元只有一行，一个文件夹的删除单元里是整棵子树里的文档
   */
  async lockInEntries(entryIds: readonly string[], transaction: Transaction): Promise<TrashedDocumentRow[]> {
    if (entryIds.length === 0)
      return []
    return executorOf(this.db, transaction)
      .select({ id: d.id, trashEntryId: d.trashEntryId })
      .from(d)
      .where(inIdArray(d.trashEntryId, entryIds))
      .orderBy(asc(d.id))
      .for('update')
  }

  /**
   * 这些文件夹里正常状态的、不是这个人创建的文档有多少份（P4-S3 spec §2）：
   * 编辑者只能删除"子树里正常状态的文档全部是本人创建的"文件夹，这一条在空间树的锁下用这一条语句判断，
   * 不在纯函数里——展开子树之后可能有人往里移进别人的文档
   */
  async countCreatedByOthers(folderIds: readonly string[], spaceId: string, userId: string, transaction: Transaction): Promise<number> {
    if (folderIds.length === 0)
      return 0
    const [row] = await executorOf(this.db, transaction)
      .select({ count: sql<number>`count(*)::int` })
      .from(d)
      .where(and(inIdArray(d.folderId, folderIds), eq(d.spaceId, spaceId), eq(d.status, 'active'), ne(d.createdBy, userId)))
    return row?.count ?? 0
  }

  /**
   * 这个空间里、这些文件夹下正常状态的文档有几份：永久删除之前核对"要删的都在回收站里"
   * （TrashEntryPurger，M2-P6 复核 A 的 S-3、B 的 B2）。条件与 lockInFolders 同形（空间 + 文件夹），走 (space_id, folder_id, …) 的索引：
   * 它在树锁与行锁之下、每次永久删除文件夹单元都执行，不带空间时要扫整个文档索引（M2-P6 第 3 片甲批复验者的测量：
   * 40 万份文档、5000 个空间的库上，不带空间 24 ms，带空间 0.04 ms）。
   * 只数这个空间仍然安全：别的空间里挂在这些文件夹下的文档（数据不一致）不会被 lockInFolders 锁住、也不会被删，
   * 随后删这些文件夹时撞上文档指向文件夹的 RESTRICT 外键，整个事务回滚，什么也不删
   */
  async countActiveInFolders(folderIds: readonly string[], spaceId: string, transaction: Transaction): Promise<number> {
    if (folderIds.length === 0)
      return 0
    const [row] = await executorOf(this.db, transaction)
      .select({ count: sql<number>`count(*)::int` })
      .from(d)
      .where(and(inIdArray(d.folderId, folderIds), eq(d.spaceId, spaceId), eq(d.status, 'active')))
    return row?.count ?? 0
  }

  /**
   * 放进回收站（调用方已锁住这些行）：状态与所属的删除单元在同一条语句里一起写（CHECK 要求二者一致），
   * 写入代次加一——删除改变了谁能写（00 号计划书 §6.4）。更新时间不变：内容没有改
   */
  async trash(ids: readonly string[], trashEntryId: string, transaction: Transaction): Promise<number> {
    if (ids.length === 0)
      return 0
    const rows = await executorOf(this.db, transaction)
      .update(d)
      .set({ status: 'trashed', trashEntryId, writeEpoch: sql`${d.writeEpoch} + 1` })
      .where(inIdArray(d.id, ids))
      .returning({ id: d.id })
    return rows.length
  }

  /**
   * 从回收站恢复（调用方已锁住这些行）：整单一起回到正常状态，清空所属的删除单元。
   * 写入代次**不再加一**（删除时已经加过，恢复不改变"谁能写"的判断依据，P4-S3 spec §3）。
   * folderId 给出时一起写（一份文档的单元回到它的原位置）；undefined 表示位置不变（文件夹的单元里，文档仍在各自的文件夹下）
   */
  async restoreInEntry(trashEntryId: string, folderId: string | null | undefined, transaction: Transaction): Promise<number> {
    const changes = { status: 'active' as const, trashEntryId: null }
    const rows = await executorOf(this.db, transaction)
      .update(d)
      .set(folderId === undefined ? changes : { ...changes, folderId })
      .where(eq(d.trashEntryId, trashEntryId))
      .returning({ id: d.id })
    return rows.length
  }

  /**
   * 每个删除单元里有多少份文档：一条按删除单元 id 的计数，不展开子树（P4-S3 spec §6）。
   * 回收站列表的份数用它；永久删除之后判断哪些单元空了也用它（没有出现在结果里的就是空的）
   */
  async countByTrashEntries(entryIds: readonly string[], transaction?: Transaction): Promise<ReadonlyMap<string, number>> {
    if (entryIds.length === 0)
      return new Map()
    const rows = await executorOf(this.db, transaction)
      .select({ trashEntryId: d.trashEntryId, count: sql<number>`count(*)::int` })
      .from(d)
      .where(inIdArray(d.trashEntryId, entryIds))
      .groupBy(d.trashEntryId)
    return new Map(rows.flatMap(row => row.trashEntryId === null ? [] : [[row.trashEntryId, row.count] as const]))
  }

  /** 永久删除（调用方已锁住这些行）：内容、修订记录与单独授权随外键 cascade 一起没了（ADR-016 的连带，授权见 M2-P5 设计 §3.3）。 */
  async deleteMany(ids: readonly string[], transaction: Transaction): Promise<number> {
    if (ids.length === 0)
      return 0
    const rows = await executorOf(this.db, transaction).delete(d).where(inIdArray(d.id, ids)).returning({ id: d.id })
    return rows.length
  }

  /**
   * 移到另一个空间（调用方已锁住这些行）：写入代次加一（00 号计划书 §6.4）。
   * folderId 给出目标位置时一起写：文件夹属于某一个空间，换了空间就不能再留在原来的文件夹里（整批转移时是目标空间的根目录）；
   * folderId 为 undefined 表示位置不变——跟着所在的文件夹换空间时，它们仍然在各自的父文件夹里（M2-P4 设计 §3.4）。
   * 更新时间不变：内容没有改，列表的排序与游标不因为挪位置而变（与改名、空间内移动一致）
   */
  async moveToSpace(ids: readonly string[], spaceId: string, folderId: string | null | undefined, transaction: Transaction): Promise<DocumentRow[]> {
    const changes = { spaceId, writeEpoch: sql`${d.writeEpoch} + 1` }
    return executorOf(this.db, transaction)
      .update(d)
      .set(folderId === undefined ? changes : { ...changes, folderId })
      .where(inIdArray(d.id, ids))
      .returning(COLUMNS)
  }

  /** 改标题（调用方已锁住这一行）：更新时间不变，内容没有改 */
  async rename(id: string, title: string, transaction: Transaction): Promise<DocumentRow> {
    return this.updated(id, { title }, transaction)
  }

  /** 在同一个空间里换文件夹（null 表示空间的根目录，调用方已锁住这一行）：写入代次不变（00 号计划书 §6.4：空间内移动不递增） */
  async moveToFolder(id: string, folderId: string | null, transaction: Transaction): Promise<DocumentRow> {
    return this.updated(id, { folderId }, transaction)
  }

  private async updated(id: string, changes: { title?: string, folderId?: string | null }, transaction: Transaction): Promise<DocumentRow> {
    const [row] = await executorOf(this.db, transaction).update(d).set(changes).where(eq(d.id, id)).returning(COLUMNS)
    if (row === undefined)
      throw new Error(`改动时文档不在了：${id}`)
    return row
  }

  async insert(document: NewDocument, transaction: Transaction): Promise<DocumentRow> {
    const [row] = await executorOf(this.db, transaction).insert(d).values({ ...document, revision: 1 }).returning(COLUMNS)
    if (row === undefined)
      throw new Error('新建文档没有返回记录')
    return row
  }

  /**
   * 按源文档建一份副本（M2-P4 设计 §3.4 第 4 条）：类型、unitId、档案、格式版本与写入时的 SDK 版本由
   * INSERT … SELECT 从源文档原样复制（unitId 相同是有意的，00 号计划书 §8.3）；
   * 修订号、写入代次、状态与时间用列的默认值（修订号 1、代次 0、正常状态）。
   * 源文档已经不在（被删或进了回收站）时什么也不写，返回 undefined（调用方持着源文档行的共享锁时不会发生）。
   * 内容的复制见 DocumentContentsRepository.copyFrom
   */
  async copyFrom(sourceId: string, copy: CopiedDocument, transaction: Transaction): Promise<DocumentRow | undefined> {
    const executor = executorOf(this.db, transaction)
    const inserted = await executor.execute<{ id: string }>(sql`
      INSERT INTO ${d} (space_id, folder_id, title, created_by, type, unit_id, profile, format_version, sdk_version)
      SELECT ${copy.spaceId}::uuid, ${copy.folderId}::uuid, ${copy.title}, ${copy.createdBy}::uuid, ${d.type}, ${d.unitId}, ${d.profile}, ${d.formatVersion}, ${d.sdkVersion}
      FROM ${d} WHERE ${d.id} = ${sourceId}::uuid AND ${d.status} = 'active'
      RETURNING ${d.id}`)
    const id = inserted.rows[0]?.id
    // 按主键再读一次：RETURNING 里算不出游标用的更新时间（keysetPosition）
    return id === undefined ? undefined : this.findById(id, transaction)
  }

  /**
   * 修订号前进到 revision（调用方已经锁住这一行并核对过当前修订号），同时更新更新时间与写入时的 SDK 版本。
   * 条件里再核对一次前一个修订号：万一调用方没有锁住这一行，也不会把修订号写乱。
   */
  async advanceRevision(id: string, revision: number, sdkVersion: string, transaction: Transaction): Promise<void> {
    const updated = await executorOf(this.db, transaction)
      .update(d)
      .set({ revision, sdkVersion, updatedAt: sql`now()` })
      .where(and(eq(d.id, id), eq(d.revision, revision - 1)))
      .returning({ id: d.id })
    if (updated.length !== 1)
      throw new Error(`修订号没有从 ${revision - 1} 前进到 ${revision}：${id}`)
  }

  /**
   * 写入代次加一（调用方已锁住这一行，M3-P1 设计 §3.3）：申请编辑权产生新的一代，收回写入权结束租约时让旧的那一代过时。
   * 返回加一之后的代次（申请把它记在租约上）。更新时间不变：申请编辑权与收回写入权都不是修改文档，列表的排序与游标不动
   * （与改名、移动一致）。不看文档的状态：收回写入权时文档可能刚被放进回收站
   */
  async advanceWriteEpoch(id: string, transaction: Transaction): Promise<number> {
    const [row] = await executorOf(this.db, transaction)
      .update(d)
      .set({ writeEpoch: sql`${d.writeEpoch} + 1` })
      .where(eq(d.id, id))
      .returning({ writeEpoch: d.writeEpoch })
    if (row === undefined)
      throw new Error(`代次加一时文档不在了：${id}`)
    return row.writeEpoch
  }

  /**
   * 同 advanceWriteEpoch，一条语句给这些文档的写入代次各加一（收回写入权结束了它们上面的租约，P1 设计 §3.4.6 第 3 步）：
   * 调用方已锁住这些文档行；更新时间不变，不看状态。一串 id 作为一个数组参数（规范 §5）
   */
  async advanceWriteEpochs(ids: readonly string[], transaction: Transaction): Promise<void> {
    if (ids.length === 0)
      return
    const rows = await executorOf(this.db, transaction)
      .update(d)
      .set({ writeEpoch: sql`${d.writeEpoch} + 1` })
      .where(inIdArray(d.id, ids))
      .returning({ id: d.id })
    if (rows.length !== new Set(ids).size)
      throw new Error(`代次加一时有文档不在了：应有 ${new Set(ids).size} 份，改了 ${rows.length} 份`)
  }
}
