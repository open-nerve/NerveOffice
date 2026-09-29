import type { SQL } from 'drizzle-orm'
import type { Database, Transaction } from '../database/index.ts'
import { FOLDER_LIST_MAX_ITEMS } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { folders } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

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

  /** 同一个 requestId 已经建过的文件夹（新建的重放，见 FoldersService.create）。 */
  async findByRequestId(requestId: string, transaction: Transaction): Promise<FolderRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(f).where(and(eq(f.requestId, requestId), eq(f.status, 'active')))
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
