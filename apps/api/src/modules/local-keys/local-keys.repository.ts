import type { Buffer } from 'node:buffer'
import type { Database, Transaction } from '../database/index.ts'
import type { WrappedLocalKey } from './master-keyring.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, count, eq, isNull, sql } from 'drizzle-orm'
import { userLocalKeys } from '../../db/schema/local-keys/index.ts'
import { DATABASE, executorOf, inIdArray } from '../database/index.ts'

/** 库里一个人当前的那一把：版本与包装之后的密钥材料 */
export interface StoredLocalKey {
  readonly version: number
  readonly material: WrappedLocalKey
}

/** 一个人当前的那一把的摘要（版本与生成的时刻）：管理界面的账户用，不带密钥材料 */
export interface LocalKeyRecord {
  readonly userId: string
  readonly version: number
  readonly createdAt: Date
}

/** 当前的本机密钥按包装它的主密钥分组的把数（启动自检） */
export interface MasterKeyUsage {
  readonly masterKeyId: Buffer
  readonly keys: number
}

/** 当前的那一把（revoked_at 为空）：部分唯一索引保证每人至多一把 */
function current() {
  return isNull(userLocalKeys.revokedAt)
}

/**
 * 只有它读写 user_local_keys（规范 §1.2，M3-P6 设计 §3.2）。时间一律取数据库的，也只在数据库里传：第 1 版的生成时刻是插入它的事务的 now()；
 * 吊销的时刻是吊销语句执行时的 clock_timestamp()（不是事务开始的 now()，见 revokeCurrent）；之后的各版生成于上一版被吊销的那一刻
 * （insertNext 在 SQL 里取上一版的 revoked_at，不经 JavaScript）。
 * 锁：只有吊销对行加锁（UPDATE），取用与读版本都不加锁（MVCC 读到的是语句开始时已提交的那一把）；全局锁顺序里本机密钥行排在最后、审计之前
 */
@Injectable()
export class LocalKeysRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 这个人当前的那一把（不加锁）；没有时为 undefined */
  async findCurrent(userId: string, transaction: Transaction): Promise<StoredLocalKey | undefined> {
    const k = userLocalKeys
    const [row] = await executorOf(this.db, transaction)
      .select({ version: k.version, masterKeyId: k.masterKeyId, wrappedKey: k.wrappedKey })
      .from(k)
      .where(and(eq(k.userId, userId), current()))
    if (row === undefined)
      return undefined
    // 表上的 CHECK：当前的那一把一定有密钥材料
    if (row.masterKeyId === null || row.wrappedKey === null)
      throw new Error('当前的本机密钥没有密钥材料')
    return { version: row.version, material: { masterKeyId: row.masterKeyId, wrappedKey: row.wrappedKey } }
  }

  /**
   * 插这个人的第 1 版（第一次取用）。ON CONFLICT DO NOTHING 不带冲突目标：撞主键（并发的另一次取用已经插了第 1 版）与撞部分唯一索引
   * （已经有当前的一把）都接住；对方还没提交时等它的结局——提交了这里什么也不写，回滚了这里照常插进去（探索 A 实测）。返回插进去了没有
   */
  async insertFirst(userId: string, material: WrappedLocalKey, transaction: Transaction): Promise<boolean> {
    const rows = await executorOf(this.db, transaction)
      .insert(userLocalKeys)
      .values({ userId, version: 1, masterKeyId: material.masterKeyId, wrappedKey: material.wrappedKey })
      .onConflictDoNothing()
      .returning({ version: userLocalKeys.version })
    return rows.length > 0
  }

  /**
   * 吊销这个人当前的那一把：记下时刻，擦掉主密钥标识与包装结果（库里不再留能解开旧草稿的东西）。返回被吊销的版本；没有当前的时为 undefined。
   * 调用方先锁了账户行：两个并发的吊销只靠这条语句的行锁时，后一个在 READ COMMITTED 的重新检查下拿到 0 行、被当成"没有可吊销的"（探索 A 实测）。
   * 时刻取这条语句执行时的 clock_timestamp()，不取事务开始的 now()：吊销开了事务、在锁上等着（system-admins 的锁、账户行）的时候，
   * 别的事务可能生成并提交了当前的那一把（本人第一次取用，或者另一个吊销生成的下一版），它的生成时刻晚于这个事务开始的时刻，
   * 记 now() 的话吊销早于生成、违反 revoked_at >= created_at，吊销 500（审查 A1，确定的交错见 local-key-races.test.ts）。
   * 这条语句看得到的那一把，插入它的事务已经提交，执行时的时刻必然晚于它的生成：约束只有数据库的时钟往回调时才可能失败。
   * 时刻不交出去：下一版的生成时刻由 insertNext 在 SQL 里取（复验 C2）
   */
  async revokeCurrent(userId: string, transaction: Transaction): Promise<number | undefined> {
    const k = userLocalKeys
    const [row] = await executorOf(this.db, transaction)
      .update(k)
      .set({ revokedAt: sql`clock_timestamp()`, masterKeyId: null, wrappedKey: null })
      .where(and(eq(k.userId, userId), current()))
      .returning({ version: k.version })
    return row?.version
  }

  /**
   * 插下一版（吊销的事务里，紧跟在 revokeCurrent 之后）：生成时刻在 SQL 里直接取上一版（version - 1）的 revoked_at——同一个事务里
   * 刚写的那一行这条语句看得到。时间线单调，下一版生成于上一版被吊销的那一刻（不变量 I21）；取这个事务的 now()（列的默认值）的话，
   * 会早于上一版的生成（审查 A1 的交错）。时刻不经 JavaScript 传，连接的时区与日期格式都碰不到它（复验 C2：原来按 UTC 文本交出、
   * 再转回 timestamptz，换算漏了时区时测试库的 UTC 会话看不出来）。上一版不在或没有被吊销时子查询为 NULL，created_at 的 NOT NULL
   * 约束让插入失败、事务回滚。账户行的锁把同一个人的吊销串起来，不会撞上别的
   */
  async insertNext(userId: string, version: number, material: WrappedLocalKey, transaction: Transaction): Promise<void> {
    const k = userLocalKeys
    await executorOf(this.db, transaction)
      .insert(k)
      .values({
        userId,
        version,
        masterKeyId: material.masterKeyId,
        wrappedKey: material.wrappedKey,
        createdAt: sql`(SELECT ${k.revokedAt} FROM ${k} WHERE ${k.userId} = ${userId} AND ${k.version} = ${version} - 1)`,
      })
  }

  /** 这个人当前的那一把的版本（不加锁，按部分唯一索引读一条）；没有时为 undefined */
  async currentVersionOf(userId: string, transaction: Transaction): Promise<number | undefined> {
    const k = userLocalKeys
    const [row] = await executorOf(this.db, transaction)
      .select({ version: k.version })
      .from(k)
      .where(and(eq(k.userId, userId), current()))
    return row?.version
  }

  /** 这些人各自当前的那一把的摘要（一条语句，一串 id 是一个数组参数）；没有的人不在结果里 */
  async currentOf(userIds: readonly string[], transaction: Transaction): Promise<LocalKeyRecord[]> {
    if (userIds.length === 0)
      return []
    const k = userLocalKeys
    return executorOf(this.db, transaction)
      .select({ userId: k.userId, version: k.version, createdAt: k.createdAt })
      .from(k)
      .where(and(inIdArray(k.userId, userIds), current()))
  }

  /** 当前的本机密钥按包装它的主密钥分组的把数（启动自检，事务之外） */
  async currentUsageByMasterKey(): Promise<MasterKeyUsage[]> {
    const k = userLocalKeys
    const rows = await this.db
      .select({ masterKeyId: k.masterKeyId, keys: count() })
      .from(k)
      .where(current())
      .groupBy(k.masterKeyId)
    return rows.flatMap(row => (row.masterKeyId === null ? [] : [{ masterKeyId: row.masterKeyId, keys: row.keys }]))
  }
}
