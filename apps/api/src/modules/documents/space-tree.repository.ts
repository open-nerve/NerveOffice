import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { DATABASE, executorOf } from '../database/index.ts'

/**
 * 空间树的串行化（M2-P4 设计 §3.4 第 2 条）。删除、移动、恢复一个文件夹要先展开子树、再动里面的每一行，
 * 展开与改动之间有窗口，别人可以往子树里移进新内容。与其在窗口上打补丁，不如让**同一个空间里的结构性改动串行**：
 * 新建、改名、移动、删除、恢复、永久删除文件夹与文档，都在事务的第一步取这把事务级的 advisory lock。
 * 保存文档内容**不取**它：保存与结构改动互不阻塞（保存只锁文档行，M1-P4）。
 *
 * 锁的顺序（ADR-007 的补充，M2-P2 交接单第 53 行据此扩展）：
 * system-admins → 按登录名 → 账户行 → 重置或邀请行 → 限流计数 → 会话行 →
 * **空间树的 advisory lock（按空间 id 排序）** → 空间行（按 id）→ 成员行 → 树里的行（文件夹行、文档行（按 id）、回收站行）→ 审计。
 * 跨空间的操作按空间 id 排序取两把，两个方向的跨空间移动同时发生时不成环。
 *
 * 树里的三类行之间没有统一的先后（M2-P6 复核 A 的 G-1）：删除文件夹、恢复与永久删除是"文档行 → 回收站行 → 文件夹行"，
 * 跨空间移动文件夹是"文件夹行 → 文档行 → 回收站行"。不会成环，靠的是这条不变量：
 * **文件夹行与回收站行只被持有它所在空间树锁的事务改动**（新建、改名、移动、删除、恢复、永久删除与到期清理都先取这把锁）。
 * 两个事务要争同一个空间的文件夹行或回收站行，必然先在这把树锁上排队，持锁的一方独自拿这些行，它们之间谁先谁后无关紧要。
 * 不取树锁就能改的只有文档行：保存内容只锁一行，停用者文档的转移按 id 顺序锁一批（见 DocumentTransferService），
 * 两者都不碰文件夹行与回收站行；结构改动也按 id 顺序锁文档行，所以在文档行上相遇时同样不成环。
 * 新增改动文件夹行或回收站行的写法时，必须先取它所在空间的树锁，否则这条不变量就不成立了。
 *
 * 没有自己的表，只有这把锁；按 `*.repository.ts` 命名，因为只有仓储能执行语句（规范 §1.2）。
 */
@Injectable()
export class SpaceTreeRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * 取这些空间的树锁：先去重、按 id 排序再逐个取，跨空间的两个操作方向相反时也不成环。
   * 排序前统一成小写：同一个 UUID 的两种写法排出不同的顺序就失去了防成环的意义（请求里的 id 已由契约统一成小写，这里是兜底）。
   * 锁键用数据库规范化之后的 UUID（与新建文档的 requestId 锁同样的理由，Codex 评审 CX7）。
   */
  async lock(spaceIds: readonly string[], transaction: Transaction): Promise<void> {
    const ordered = [...new Set(spaceIds.map(id => id.toLowerCase()))].sort()
    for (const spaceId of ordered) {
      // 逐个、按顺序取：顺序就是防成环的依据，不能并发发出
      await executorOf(this.db, transaction).execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('nerve-office:space-tree:' || (${spaceId})::uuid::text, 0))`)
    }
  }
}
