import { Injectable } from '@nestjs/common'
import { DatabaseTime } from '../database/index.ts'

/**
 * 时钟（M2-P4 设计 §3.4 第 6 条）：定时任务问"现在几点"只经它，每一轮开头问一次，作为这一轮的"现在"。
 * "是否到期"在 SQL 里按 `expires_at <= $now` 判断，$now 由这里给出，而不是直接写 now()——
 * 测试注入一个可控的时钟，就能把时间推到 30 天之后，不必真的等。
 *
 * 写成抽象类而不是接口：Nest 按类型注入，注入标记就是这个类本身。
 */
@Injectable()
export abstract class Clock {
  abstract now(): Promise<Date>
}

/**
 * 生产用的实现：数据库的当前时间（规范 §5：与时间有关的判断使用数据库时间，M2-P6 复核 A 的疑点 Q-1）。
 * 到期时间是数据库的 now() 算的（删除时的时间加 30 天），用应用主机的时钟去比，主机的钟快多少就会提前多少永久删除；
 * 每一轮开头多一条很轻的查询
 */
@Injectable()
export class DatabaseClock extends Clock {
  constructor(private readonly time: DatabaseTime) {
    super()
  }

  async now(): Promise<Date> {
    return this.time.now()
  }
}
