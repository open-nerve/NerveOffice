import type { DocumentStatus } from '@nerve-office/contracts'
import type { SQL } from 'drizzle-orm'
import type { Buffer } from 'node:buffer'
import type { Database, Transaction } from '../database/index.ts'
import { FOLDER_LIST_MAX_ITEMS } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { folders } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf, inIdArray } from '../database/index.ts'

export interface FolderRow {
  readonly id: string
  readonly spaceId: string
  /** 在空间的根目录下时为空 */
  readonly parentId: string | null
  readonly name: string
  readonly createdBy: string
  /** 第几层：空间根目录下的文件夹是 1 */
  readonly depth: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** 新建文件夹要写的列：状态为正常，时间取数据库的当前时间。 */
export interface NewFolder {
  readonly spaceId: string
  readonly parentId: string | null
  readonly name: string
  readonly createdBy: string
  readonly depth: number
  readonly requestId: string
  /** 新建请求的摘要（payload-digest.ts 的 folderCreatedPayloadDigest）：重放按它判断，之后不改（M2 Codex 评审 CX6） */
  readonly payloadDigest: Buffer
}

/** 按 requestId 找到的文件夹（新建的重放）：现在的样子，连同新建时存下的请求摘要与现在的状态 */
export interface CreatedFolderRow extends FolderRow {
  readonly payloadDigest: Buffer
  /** 正常（active）或在回收站里（trashed）：在回收站里的，重放按"看不到"回答（FoldersService 的 replay） */
  readonly status: DocumentStatus
}

/** 一棵子树（含根）的摘要：移动之前判断层数与成环，跨空间移动还要按它找出里面的文档。 */
export interface SubtreeSummary {
  /** 子树里最深的一层；子树只有根时就是根的层数 */
  readonly maxDepth: number
  /** 目标的父文件夹是不是就在这棵子树里（含根）：是就会成环 */
  readonly containsCandidate: boolean
  /** 子树里全部文件夹的 id（含根）：跨空间移动据此锁住并搬走里面的文档，条数也是审计里的文件夹数 */
  readonly ids: string[]
}

/** 拼路径要用的一个文件夹（M2-P4 设计 §3.4 第 5 条）：它自己的名称与父文件夹。 */
export interface FolderAncestorRow {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
}

/** 把一棵子树整个挪走：换父文件夹、整棵加上层差，跨空间时连所属空间一起改。 */
export interface SubtreeMove {
  readonly rootId: string
  /** 根的新父文件夹；null 表示空间的根目录 */
  readonly parentId: string | null
  /** 整棵子树（含根）的层数一起加上它 */
  readonly depthDelta: number
  /** 跨空间移动时的目标空间：整棵子树一起换；在同一个空间里移动时省略 */
  readonly spaceId?: string | undefined
}

const f = folders
const COLUMNS = {
  id: f.id,
  spaceId: f.spaceId,
  parentId: f.parentId,
  name: f.name,
  createdBy: f.createdBy,
  depth: f.depth,
  createdAt: f.createdAt,
  updatedAt: f.updatedAt,
}

/**
 * 对一棵子树（含根）的 id 与层数做 projection 的查询；可以单独执行，也可以当子查询（`id IN (…)`）用。
 * 展开时不看状态：已经在回收站里的子孙也跟着父辈移动、跟着算层数，这样它们恢复回原位时仍然放得下（M2-P4 设计 §3.4）。
 * 子查询里的列写全名（`"folders"."id"`，P1 交接单第 64 行的坑）；递归的那一支给表另起别名，不与外层的 UPDATE 混淆
 */
function subtreeQuery(rootId: string, projection: SQL): SQL {
  return sql`WITH RECURSIVE subtree(id, depth) AS (
    SELECT ${f.id}, ${f.depth} FROM ${f} WHERE ${f.id} = ${rootId}
    UNION ALL
    SELECT child.id, child.depth FROM ${f} AS child JOIN subtree ON child.parent_id = subtree.id
  ) ${projection}`
}

/** 只有它读写 folders（规范 §1.2）。空间树的串行化见 space-tree.repository.ts。 */
@Injectable()
export class FoldersRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 正常状态的一个文件夹；不存在或已经在回收站里时为 undefined。 */
  async findById(id: string, transaction?: Transaction): Promise<FolderRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(f).where(and(eq(f.id, id), eq(f.status, 'active')))
    return row
  }

  /**
   * 同一个 requestId 已经建过的文件夹，连同新建时的请求摘要与现在的状态（新建的重放，见 FoldersService.create）。
   * 进了回收站的也找出来（M2 Codex 评审第二轮复验的一般 4）：原来只找正常状态的，进了回收站之后原样的重发被当成新的请求，
   * 回答随这次请求里的空间而变——能新建时插入撞上唯一约束是 409，降为查看者是 403，被移出空间是 404，
   * 而新建文档在这三种情况下一律是 409；客户端遇到 403、404 会说"新建被拒绝"，实际上却已经建过
   */
  async findByRequestId(requestId: string, transaction: Transaction): Promise<CreatedFolderRow | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .select({ ...COLUMNS, payloadDigest: f.payloadDigest, status: f.status })
      .from(f)
      .where(eq(f.requestId, requestId))
    return row
  }

  /**
   * 一层里的文件夹：某个空间里某个父文件夹（parentId 为空表示空间的根目录）的直接子文件夹，正常状态的。
   * 按名称（不区分大小写）、id 排序，顺序确定，截断时每次截在同一处。多取一条，调用方据此判断有没有被截断
   */
  async listChildren(spaceId: string, parentId: string | null, transaction?: Transaction): Promise<FolderRow[]> {
    return executorOf(this.db, transaction)
      .select(COLUMNS)
      .from(f)
      .where(and(
        eq(f.spaceId, spaceId),
        parentId === null ? isNull(f.parentId) : eq(f.parentId, parentId),
        eq(f.status, 'active'),
      ))
      .orderBy(sql`lower(${f.name})`, asc(f.id))
      .limit(FOLDER_LIST_MAX_ITEMS + 1)
  }

  /**
   * 建一个文件夹。requestId 已经被别的新建用掉时不写，返回 undefined：
   * 用 ON CONFLICT 而不是等唯一约束报错，事务不会因此中止（与修订记录同一个做法）
   */
  async insert(folder: NewFolder, transaction: Transaction): Promise<FolderRow | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .insert(f)
      .values(folder)
      .onConflictDoNothing({ target: f.requestId })
      .returning(COLUMNS)
    return row
  }

  async rename(id: string, name: string, transaction: Transaction): Promise<FolderRow> {
    const [row] = await executorOf(this.db, transaction).update(f).set({ name, updatedAt: sql`now()` }).where(eq(f.id, id)).returning(COLUMNS)
    if (row === undefined)
      throw new Error(`改名时文件夹不在了：${id}`)
    return row
  }

  /**
   * 这棵子树最深的一层、里面全部文件夹的 id，以及 candidateParentId 是不是就在这棵子树里（含根）。
   * candidateParentId 为空（移到空间的根目录）时不可能成环，containsCandidate 为假。
   * 一次展开把三样一起取出来：移动前的判断、跨空间时找文档、审计里的文件夹数都用它，不重复展开子树
   */
  async summarizeSubtree(rootId: string, candidateParentId: string | null, transaction: Transaction): Promise<SubtreeSummary> {
    const projection = sql`SELECT max(depth) AS "maxDepth", coalesce(bool_or(id = ${candidateParentId}::uuid), false) AS "containsCandidate", array_agg(id) AS ids FROM subtree`
    const result = await executorOf(this.db, transaction).execute<{ maxDepth: number | null, containsCandidate: boolean, ids: string[] | null }>(subtreeQuery(rootId, projection))
    const row = result.rows[0]
    if (row === undefined || row.maxDepth === null || row.ids === null)
      throw new Error(`展开子树时文件夹不在了：${rootId}`)
    return { maxDepth: row.maxDepth, containsCandidate: row.containsCandidate, ids: row.ids }
  }

  /**
   * 这棵子树（含根）里正常状态的文件夹（删除一个文件夹时要放进删除单元的那些）：
   * 已经在回收站里的子孙留在原来的删除单元里，不并进这次的（P4-S3 spec §1），所以递归只走正常状态的行。
   * 根不是正常状态时结果为空，调用方在锁下重新读过根，不会走到这一步
   */
  async activeSubtreeIds(rootId: string, transaction: Transaction): Promise<string[]> {
    const query = sql`WITH RECURSIVE subtree(id) AS (
      SELECT ${f.id} FROM ${f} WHERE ${f.id} = ${rootId} AND ${f.status} = 'active'
      UNION ALL
      SELECT child.id FROM ${f} AS child JOIN subtree ON child.parent_id = subtree.id AND child.status = 'active'
    ) SELECT array_agg(id) AS ids FROM subtree`
    const result = await executorOf(this.db, transaction).execute<{ ids: string[] | null }>(query)
    return result.rows[0]?.ids ?? []
  }

  /** 这些文件夹里正常状态的有几个：永久删除之前核对"要删的都在回收站里"（TrashEntryPurger，M2-P6 复核 A 的 S-3、B 的 B2）。 */
  async countActive(ids: readonly string[], transaction: Transaction): Promise<number> {
    if (ids.length === 0)
      return 0
    const [row] = await executorOf(this.db, transaction)
      .select({ count: sql<number>`count(*)::int` })
      .from(f)
      .where(and(inIdArray(f.id, ids), eq(f.status, 'active')))
    return row?.count ?? 0
  }

  /** 这些文件夹分属哪些删除单元（去重，正常状态的行不算）：跨空间移动与永久删除据此找到牵连到的删除单元。 */
  async trashEntryIdsIn(folderIds: readonly string[], transaction: Transaction): Promise<string[]> {
    if (folderIds.length === 0)
      return []
    const rows = await executorOf(this.db, transaction)
      .selectDistinct({ trashEntryId: f.trashEntryId })
      .from(f)
      .where(and(inIdArray(f.id, folderIds), isNotNull(f.trashEntryId)))
    return rows.flatMap(row => row.trashEntryId === null ? [] : [row.trashEntryId])
  }

  /** 每个删除单元里还剩多少个文件夹：永久删除之后判断哪些单元空了（没有出现在结果里的就是空的）。 */
  async countByTrashEntries(entryIds: readonly string[], transaction?: Transaction): Promise<ReadonlyMap<string, number>> {
    if (entryIds.length === 0)
      return new Map()
    const rows = await executorOf(this.db, transaction)
      .select({ trashEntryId: f.trashEntryId, count: sql<number>`count(*)::int` })
      .from(f)
      .where(inIdArray(f.trashEntryId, entryIds))
      .groupBy(f.trashEntryId)
    return new Map(rows.flatMap(row => row.trashEntryId === null ? [] : [[row.trashEntryId, row.count] as const]))
  }

  /** 属于这个删除单元的全部文件夹（恢复与永久删除按它取出整棵子树），按层数从浅到深。 */
  async listInEntry(trashEntryId: string, transaction: Transaction): Promise<FolderRow[]> {
    return executorOf(this.db, transaction).select(COLUMNS).from(f).where(eq(f.trashEntryId, trashEntryId)).orderBy(asc(f.depth), asc(f.id))
  }

  /**
   * 这些文件夹连同它们的全部祖先（M2-P4 设计 §3.4 第 5 条）：搜索结果的路径由它一次取齐。
   * 一条语句、一次往返：按 id 批量给出起点，父链在数据库里一次走完（层数至多 FOLDER_MAX_DEPTH，
   * 有 CHECK 兜住），既不按结果条数一条条查，也不按层数来回查；拼成名称数组在内存里做（folder-path.ts）。
   * 起点与每一级祖先都限定在调用者看得到的空间里（设计 §3.5）：万一有哪一行的父文件夹在别的空间里，
   * 那个空间的名称也不会顺着父链漏出来。UNION 去重：多条路径共用祖先时不会重复展开
   */
  async ancestorsOf(ids: readonly string[], spaceIds: readonly string[], transaction?: Transaction): Promise<FolderAncestorRow[]> {
    if (ids.length === 0 || spaceIds.length === 0)
      return []
    const query = sql`WITH RECURSIVE ancestors(id, parent_id, name) AS (
      SELECT ${f.id}, ${f.parentId}, ${f.name} FROM ${f}
        WHERE ${inIdArray(f.id, ids)} AND ${inIdArray(f.spaceId, spaceIds)}
      UNION
      SELECT parent.id, parent.parent_id, parent.name FROM ${f} AS parent
        JOIN ancestors ON parent.id = ancestors.parent_id AND ${inIdArray(sql`parent.space_id`, spaceIds)}
    ) SELECT id, parent_id AS "parentId", name FROM ancestors`
    return (await executorOf(this.db, transaction).execute<{ id: string, parentId: string | null, name: string }>(query)).rows
  }

  /** 按 id 取这些文件夹里正常状态的那些的名称（回收站列表里"原位置"的显示名）。 */
  async activeNamesOf(ids: readonly string[], spaceId: string, transaction?: Transaction): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0)
      return new Map()
    const rows = await executorOf(this.db, transaction)
      .select({ id: f.id, name: f.name })
      .from(f)
      .where(and(inIdArray(f.id, [...new Set(ids)]), eq(f.spaceId, spaceId), eq(f.status, 'active')))
    return new Map(rows.map(row => [row.id, row.name]))
  }

  /**
   * 整棵子树放进回收站（调用方已在空间树的锁下展开过子树）：状态与所属的删除单元在同一条语句里一起写
   * （CHECK 要求二者一致）。层数不变（P4-S3 spec §1）：恢复回原位时正好放得回去
   */
  async trashMany(ids: readonly string[], trashEntryId: string, transaction: Transaction): Promise<number> {
    if (ids.length === 0)
      return 0
    const rows = await executorOf(this.db, transaction)
      .update(f)
      .set({ status: 'trashed', trashEntryId })
      .where(inIdArray(f.id, ids))
      .returning({ id: f.id })
    return rows.length
  }

  /**
   * 把一个删除单元里的文件夹整单恢复，与 moveSubtree 同一个形状，一条 UPDATE：
   * - 范围是**根的整棵递归子树**（不看状态），层数一起加上 depthDelta——里面还留在回收站、属于别的删除单元的
   *   子孙也要跟着降层，否则它们带着旧层数留下来，之后这个文件夹的合法移动会被 409 误判成超限（审查 A2）；
   * - 回到正常状态、清空所属的删除单元只对**这一单的行**生效（CASE WHEN：状态与删除单元一起写，CHECK 要求二者一致）；
   * - 只有这一单的根换父文件夹（parentId 为 null 表示回到空间的根目录）。
   *
   * 返回改动的行数（整棵子树，含仍在回收站里的子孙）。
   */
  async restoreInEntry(trashEntryId: string, rootId: string, parentId: string | null, depthDelta: number, transaction: Transaction): Promise<number> {
    const inEntry = sql`${f.trashEntryId} = ${trashEntryId}::uuid`
    const rows = await executorOf(this.db, transaction)
      .update(f)
      .set({
        status: sql`CASE WHEN ${inEntry} THEN 'active' ELSE ${f.status} END`,
        trashEntryId: sql`CASE WHEN ${inEntry} THEN NULL ELSE ${f.trashEntryId} END`,
        parentId: sql`CASE WHEN ${f.id} = ${rootId} THEN ${parentId}::uuid ELSE ${f.parentId} END`,
        depth: sql`${f.depth} + ${depthDelta}`,
      })
      .where(sql`${f.id} IN (${subtreeQuery(rootId, sql`SELECT id FROM subtree`)})`)
      .returning({ id: f.id })
    return rows.length
  }

  /**
   * 永久删除这些文件夹（调用方已删掉里面的文档），按层数从深到浅逐层删，层数最多 FOLDER_MAX_DEPTH，所以至多这么多条语句。
   * 逐层删是为了不依赖外键检查的时机：父子的外键是 restrict，每一条语句删的都是剩下的行里最深的一层，删的时候已经没有子行指着它们，
   * 无论外键是在语句结束时检查、还是像 SQL 标准的 RESTRICT 那样逐行立即检查都成立。PostgreSQL 把 restrict 当作不可延迟的
   * NO ACTION、在语句结束时才检查，一条语句里同时删父与子其实也能通过（PG 18.6 实测，M2-P6 复核 B 的 G3 订正了原来
   * "会被立刻拒绝"的说法）；多几条语句的代价可以接受，换来的是正确性不取决于这个时机
   */
  async deleteMany(ids: readonly string[], transaction: Transaction): Promise<number> {
    if (ids.length === 0)
      return 0
    const executor = executorOf(this.db, transaction)
    const levels = await executor.selectDistinct({ depth: f.depth }).from(f).where(inIdArray(f.id, ids)).orderBy(desc(f.depth))
    let deleted = 0
    for (const { depth } of levels) {
      const rows = await executor.delete(f).where(and(inIdArray(f.id, ids), eq(f.depth, depth))).returning({ id: f.id })
      deleted += rows.length
    }
    return deleted
  }

  /**
   * 把一棵子树整个挪到新的父文件夹下：根换父文件夹，整棵子树（含根）的层数一起加上 depthDelta；
   * 跨空间移动时（给了 spaceId）整棵子树的所属空间也一起改——子孙的父子关系不变，只有根换了父。
   * 一条 UPDATE，不逐行：子树由 WHERE 里的递归子查询给出（读的是语句开始时的快照，不受这条 UPDATE 自己的改动影响）。
   * 层数越界时数据库的 CHECK 兜底；调用方已在空间树的锁下用 summarizeSubtree 先判断过。返回更新后的根
   */
  async moveSubtree(move: SubtreeMove, transaction: Transaction): Promise<FolderRow> {
    const { rootId, parentId, depthDelta, spaceId } = move
    const executor = executorOf(this.db, transaction)
    const changes = {
      parentId: sql`CASE WHEN ${f.id} = ${rootId} THEN ${parentId}::uuid ELSE ${f.parentId} END`,
      depth: sql`${f.depth} + ${depthDelta}`,
      updatedAt: sql`now()`,
    }
    await executor
      .update(f)
      .set(spaceId === undefined ? changes : { ...changes, spaceId })
      .where(sql`${f.id} IN (${subtreeQuery(rootId, sql`SELECT id FROM subtree`)})`)
    // 再按主键读一次根：更新的是整棵子树，RETURNING 会把整棵都带回来
    const [row] = await executor.select(COLUMNS).from(f).where(eq(f.id, rootId))
    if (row === undefined)
      throw new Error(`移动时文件夹不在了：${rootId}`)
    return row
  }
}
