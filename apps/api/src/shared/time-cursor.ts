// 按时间排序的列表的游标（P3 设计 §3.3；M2-P1 起文档、邀请、审计共用）：最后一条的时间与 id，keyset 分页。对客户端不透明。
// 时间由数据库算成 UTC 文本（database 模块的 keysetPosition），与 id 一起比较。
import { Buffer } from 'node:buffer'
import { z } from 'zod'

/** 时间用数据库算出的 UTC 文本，保留微秒：换成 JavaScript 的 Date 会丢掉微秒，同一毫秒内的记录会被跳过或重复。 */
const POSITION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

/**
 * 格式对，日期也真实存在：没有 2 月 30 日、13 月、24 点、0 年。
 * 数据库解析不了的时间会让查询报错，变成 500（P3 审查 A3）。
 */
function isRealInstant(position: string): boolean {
  const instant = new Date(position)
  return !Number.isNaN(instant.getTime())
    && instant.getUTCFullYear() >= 1
    && instant.toISOString().slice(0, 23) === position.slice(0, 23)
}

const cursorSchema = z.strictObject({ t: z.string().regex(POSITION).refine(isRealInstant), i: z.uuid() })

export interface TimeCursor {
  /** 排序用的时间：数据库算出的 UTC 文本，保留微秒 */
  readonly position: string
  readonly id: string
}

export function encodeTimeCursor(cursor: TimeCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.position, i: cursor.id }), 'utf8').toString('base64url')
}

/** 不是我们发的游标（改过、截断、拼错）返回 undefined。 */
export function decodeTimeCursor(value: string): TimeCursor | undefined {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  }
  catch {
    return undefined
  }
  const cursor = cursorSchema.safeParse(decoded)
  return cursor.success ? { position: cursor.data.t, id: cursor.data.i } : undefined
}
