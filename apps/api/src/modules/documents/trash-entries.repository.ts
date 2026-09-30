import type { TrashEntryKind } from '@nerve-office/contracts'
import type { TimeCursor } from '../../shared/time-cursor.ts'
import type { Database, Transaction } from '../database/index.ts'
import { TRASH_RETENTION_DAYS } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, lte, not, sql } from 'drizzle-orm'
import { trashEntries } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf, inIdArray, keysetPosition } from '../database/index.ts'

/** 回收站里的一个删除单元。 */
export interface TrashEntryRow {
  readonly id: string
  /** 现在在哪个空间的回收站里（跨空间移动会跟着改，P4-S3 spec §6b） */
  readonly spaceId: string
  readonly kind: TrashEntryKind
  readonly deletedBy: string
  readonly deletedAt: Date
  /** 游标用的删除时间：数据库算出的 UTC 文本，保留微秒 */
  readonly position: string
  readonly expiresAt: Date
  readonly originSpaceId: string
  /** 被删的那一个对象当时的父文件夹；在空间的根目录下时为空 */
  readonly originParentId: string | null
  readonly title: string
}

/** 新建一个删除单元要写的列：删除时间取数据库的当前时间，到期时间是它加 TRASH_RETENTION_DAYS 天。 */
export interface NewTrashEntry {
  readonly spaceId: string
  readonly kind: TrashEntryKind
  readonly deletedBy: string
  readonly originSpaceId: string
  readonly originParentId: string | null
  readonly title: string
}

/** 回收站列表的分页。 */
export interface TrashListOptions {
  readonly limit: number
  /** 上一页最后一条的位置（keyset） */
  readonly after?: TimeCursor | undefined
}

const t = trashEntries
const COLUMNS = {
  id: t.id,
  spaceId: t.spaceId,
  kind: t.kind,
  deletedBy: t.deletedBy,
  deletedAt: t.deletedAt,
  position: keysetPosition(t.deletedAt),
  expiresAt: t.expiresAt,
  originSpaceId: t.originSpaceId,
  originParentId: t.originParentId,
  title: t.title,
}

/**
 * 只有它读写 trash_entries（规范 §1.2）。删除单元的语义见 P4-S3 的规则细则：
 * 一次删除产生一条，子树里的每一行指向它；恢复与永久删除按它整单处理。
 * 到期时间由数据库算（删除时间 + TRASH_RETENTION_DAYS 天），不由应用传：同一条语句里算出来，与 CHECK 一致。
 */
@Injectable()
export class TrashEntriesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(entry: NewTrashEntry, transaction: Transaction): Promise<TrashEntryRow> {
    const [row] = await executorOf(this.db, transaction)
      .insert(t)
      // 到期时间由数据库算：make_interval 取参数，不拼 SQL（规范 §5）
      .values({ ...entry, expiresAt: sql`now() + make_interval(days => ${TRASH_RETENTION_DAYS})` })
      .returning(COLUMNS)
    if (row === undefined)
      throw new Error('新建删除单元没有返回记录')
    return row
  }

  async findById(id: string, transaction?: Transaction): Promise<TrashEntryRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(t).where(eq(t.id, id))
    return row
  }

  /**
   * 锁住删除单元（FOR UPDATE）：恢复与永久删除在锁下重新读它，后到的一方看到它已经不在（NOT_FOUND，spec §7）。
   * 锁的顺序里回收站行排在文件夹行与文档行之后（ADR-007 的补充）
   */
  async lockById(id: string, transaction: Transaction): Promise<TrashEntryRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(t).where(eq(t.id, id)).for('update')
    return row
  }

  /**
   * 到期的删除单元，最早到期的在前（M2-P4 设计 §3.4 第 6 条）：到期与否按调用方给的时刻判断，
   * 不用数据库的 now()——时刻由 jobs 的时钟给出，集成测试因此不必等 30 天。走索引 trash_entries_expires_idx。
   * except 里的不取（定时清理暂缓重试的那些，M2-P6 复核 A 的 S-1）：一直失败的条目到期最早、总排在最前面，
   * 不把它们让开，攒够一批之后后面到期的就再也轮不到
   */
  async listExpired(now: Date, limit: number, except: readonly string[] = []): Promise<TrashEntryRow[]> {
    return this.db
      .select(COLUMNS)
      .from(t)
      .where(and(lte(t.expiresAt, now), except.length === 0 ? undefined : not(inIdArray(t.id, except))))
      .orderBy(asc(t.expiresAt), asc(t.id))
      .limit(limit)
  }

  /** 一个空间的回收站，按删除时间从新到旧；after 是上一页最后一条的位置（keyset，与文档列表一致）。 */
  async listBySpace(spaceId: string, options: TrashListOptions): Promise<TrashEntryRow[]> {
    const { after } = options
    return this.db
      .select(COLUMNS)
      .from(t)
      .where(and(
        eq(t.spaceId, spaceId),
        after === undefined ? undefined : sql`(${t.deletedAt}, ${t.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`,
      ))
      .orderBy(desc(t.deletedAt), desc(t.id))
      .limit(options.limit)
  }

  /**
   * 整棵子树换空间时，把完全落在这棵子树里的删除单元一起迁过去（P4-S3 spec §6b）：
   * space_id 与 origin_space_id 一起改；origin_parent_id 不用改，它指向的文件夹也在这棵子树里，跟着搬了。
   * 调用方给出的是子树里的行所属的删除单元 id——S2b 保证一个删除单元不会被拆散在两个空间，所以整单迁移是对的
   */
  async moveToSpace(ids: readonly string[], spaceId: string, transaction: Transaction): Promise<number> {
    if (ids.length === 0)
      return 0
    const rows = await executorOf(this.db, transaction)
      .update(t)
      .set({ spaceId, originSpaceId: spaceId })
      .where(inIdArray(t.id, ids))
      .returning({ id: t.id })
    return rows.length
  }

  /**
   * 删掉这些删除单元（恢复时是这一单，永久删除时还有被连带清空的别的单元，P4-S3 spec §4）。
   * 调用方要先把指向它们的文件夹与文档处理干净：外键是 restrict，还有行指着的单元删不掉
   */
  async deleteMany(ids: readonly string[], transaction: Transaction): Promise<number> {
    if (ids.length === 0)
      return 0
    const rows = await executorOf(this.db, transaction).delete(t).where(inIdArray(t.id, ids)).returning({ id: t.id })
    return rows.length
  }
}
