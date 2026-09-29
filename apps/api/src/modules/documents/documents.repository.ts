import type { DocumentProfile, DocumentStatus, DocumentType, PlatformFormatVersion } from '@nerve-office/contracts'
import type { SQL } from 'drizzle-orm'
import type { TimeCursor } from '../../shared/time-cursor.ts'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { documents } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf, keysetPosition } from '../database/index.ts'

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
}

/** 新建文档要写的列：修订号从 1 开始，状态为正常，时间取数据库的当前时间。 */
export interface NewDocument {
  readonly spaceId: string
  readonly type: DocumentType
  readonly title: string
  readonly createdBy: string
  readonly unitId: string
  readonly profile: DocumentProfile
  readonly formatVersion: PlatformFormatVersion
  readonly sdkVersion: string
}

/**
 * "可访问文档"的范围与状态（M2-P2 设计 §3.5，M2-P4 设计 §3.4 第 1 条）：两维。
 * - 范围：调用者看得到的空间，由访问策略给出（P5 在这里并上单独授权）；
 * - 状态：列表、搜索与停用者文档的转移用 active；回收站用 trashed。
 * 目录与关键词不进这里，是各自查询自己的条件（设计 §7 的取舍）。
 */
export interface AccessibleScope {
  readonly spaceIds: readonly string[]
  readonly state: DocumentStatus
}

/** 列出可访问文档的条件与分页。 */
export interface ListOptions {
  readonly limit: number
  /** 上一页最后一条的位置（keyset） */
  readonly after?: TimeCursor | undefined
  /** 按目录过滤：省略（undefined）表示不按目录过滤，null 表示空间的根目录，字符串表示某个文件夹 */
  readonly folderId?: string | null | undefined
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
}

/**
 * "可访问文档"的条件：列表、搜索、计数、回收站、"与我共享"都经这一处，不各写各的过滤条件（M2 总设计 §6.1）。
 * P5 并上单独授权也只改这里。
 */
function accessible(scope: AccessibleScope): SQL | undefined {
  return and(eq(d.status, scope.state), inArray(d.spaceId, [...scope.spaceIds]))
}

/** 目录的过滤（见 ListOptions.folderId）：不进 accessible，是列表自己的条件。 */
function inFolder(folderId: string | null | undefined): SQL | undefined {
  if (folderId === undefined)
    return undefined
  return folderId === null ? isNull(d.folderId) : eq(d.folderId, folderId)
}

/** documents 表的读写在这里（规范 §1.2）。一处例外：读取内容时修订号要与内容一起读，那条联表的语句在同一模块的 document-contents.repository.ts。 */
@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 可访问的文档，按更新时间从新到旧；after 是上一页最后一条的位置（keyset）。 */
  async listAccessible(scope: AccessibleScope, options: ListOptions): Promise<DocumentRow[]> {
    const { after } = options
    return this.db
      .select(COLUMNS)
      .from(d)
      .where(and(
        accessible(scope),
        inFolder(options.folderId),
        after === undefined ? undefined : sql`(${d.updatedAt}, ${d.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`,
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
   * 按 id 顺序锁住要转移的文档（FOR UPDATE，与保存相同）：两次转移、转移与保存都按同一个顺序取锁，互相等待时不成环。
   * 只锁来源空间里的可访问文档（与标题列表同一个条件）：请求里夹带的别处的文档不被锁住（M2-P2 审查 A4）；
   * 等锁期间被别人转走的行，拿到锁之后按新的内容重新判断，不再返回。返回锁住的 id（按 id 排序）。
   * 状态显式只取 active（M2-P4 设计 §3.4 第 1 条）：停用者回收站里的文档留在原处，30 天后自动清除——
   * 系统管理员没有内容权限，也不该替别人恢复；不按目录过滤：整个空间里的文档都要转走
   */
  async lockForTransfer(ids: readonly string[], fromSpaceId: string, transaction: Transaction): Promise<string[]> {
    const rows = await executorOf(this.db, transaction)
      .select({ id: d.id })
      .from(d)
      .where(and(inArray(d.id, [...ids]), accessible({ spaceIds: [fromSpaceId], state: 'active' })))
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
   * 限定在来源空间里：文件夹的所属空间已经在这次事务里改过时，不会把别处的行也卷进来
   */
  async lockInFolders(folderIds: readonly string[], spaceId: string, transaction: Transaction, state?: DocumentStatus): Promise<TrashedDocumentRow[]> {
    if (folderIds.length === 0)
      return []
    return executorOf(this.db, transaction)
      .select({ id: d.id, trashEntryId: d.trashEntryId })
      .from(d)
      .where(and(
        inArray(d.folderId, [...folderIds]),
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
      .where(inArray(d.trashEntryId, [...entryIds]))
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
      .where(and(inArray(d.folderId, [...folderIds]), eq(d.spaceId, spaceId), eq(d.status, 'active'), ne(d.createdBy, userId)))
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
      .where(inArray(d.id, [...ids]))
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
      .where(inArray(d.trashEntryId, [...entryIds]))
      .groupBy(d.trashEntryId)
    return new Map(rows.flatMap(row => row.trashEntryId === null ? [] : [[row.trashEntryId, row.count] as const]))
  }

  /** 永久删除（调用方已锁住这些行）：内容与修订记录随外键 cascade 一起没了。 */
  async deleteMany(ids: readonly string[], transaction: Transaction): Promise<number> {
    if (ids.length === 0)
      return 0
    const rows = await executorOf(this.db, transaction).delete(d).where(inArray(d.id, [...ids])).returning({ id: d.id })
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
      .where(inArray(d.id, [...ids]))
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
   * 源文档已经不在（被删或进了回收站）时什么也不写，返回 undefined。内容的复制见 DocumentContentsRepository.copyFrom
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
}
