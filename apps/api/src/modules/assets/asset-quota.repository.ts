import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { assetQuota } from '../../db/schema/assets/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

/** 上传与回收都先锁此单例，再操作资产/对象/退休任务；文件 IO 不在这个事务中。 */
@Injectable()
export class AssetQuotaRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async lock(tx: Transaction): Promise<typeof assetQuota.$inferSelect> {
    const db = executorOf(this.db, tx)
    await db.insert(assetQuota).values({ id: 1 }).onConflictDoNothing()
    const [row] = await db.select().from(assetQuota).where(eq(assetQuota.id, 1)).for('update')
    if (row === undefined)
      throw new Error('资源对象与持久配额记录不一致')
    return row
  }
}
