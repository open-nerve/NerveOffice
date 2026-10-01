import type { Database } from './database.ts'
import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { DATABASE } from './database.ts'

/**
 * 数据库的当前时间（规范 §5：与时间有关的判断使用数据库时间，M2-P6 复核 A 的疑点 Q-1）：给不在一条 SQL 里完成、
 * 又要拿时刻去比数据库里的时间的场合用，例如定时清理的一轮先取"现在"，再按 `expires_at <= $现在` 取到期的删除单元——
 * 到期时间是数据库的 now() 算的，用应用主机的时钟比，主机的钟快多少就提前多少永久删除。
 *
 * 数据库给出 UTC 的 ISO 文本（毫秒），不经驱动的时间解析：drizzle 在原始查询里把 timestamptz 原样当文本交回
 */
@Injectable()
export class DatabaseTime {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async now(): Promise<Date> {
    const result = await this.db.execute<{ now: string }>(sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)
    const now = result.rows[0]?.now
    if (now === undefined)
      throw new Error('数据库没有给出当前时间')
    return new Date(now)
  }
}
