import { Injectable } from '@nestjs/common'

/**
 * 时钟（M2-P4 设计 §3.4 第 6 条）：定时任务问"现在几点"只经它。
 * "是否到期"在 SQL 里按 `expires_at <= $now` 判断，$now 由这里给出，不用数据库的 now()——
 * 测试注入一个可控的时钟，就能把时间推到 30 天之后，不必真的等。
 *
 * 写成抽象类而不是接口：Nest 按类型注入，注入标记就是这个类本身。
 */
@Injectable()
export abstract class Clock {
  abstract now(): Date
}

/** 生产用的实现：系统时钟。 */
@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date()
  }
}
