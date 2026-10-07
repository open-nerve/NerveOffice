// 这一页发出过的请求编辑的记号（M3-P5 审查 B2）：编辑状态里的"本人的请求"（request.mine、reservation.mine）不分页面——同一个人在别的标签页、
// 别的设备上发出的也是。只有发出过它的那一页恢复等待（续期、关页时撤回、空闲取消、交给本人时自动进入）；别的页面要是也恢复，它关掉、空闲满 10 分钟
// 就会把用户在别的页面正在等的请求撤掉（服务端的取消按人清），交出时还可能让一个没人的页面抢进编辑。所以发出时在这一页记下它，之后按记号认：
// - 存在 sessionStorage（按标签页，刷新之后还在：设计要的"刷新时撤回没送到的话，刷新之后恢复等待"照样成立）。键 nerve-office:edit-request:<documentId>；
//   值带版本 {v, requestedAt?}——requestedAt 是服务端给的发出时刻（编辑状态里的 request.requestedAt 是同一个值；同一个人再发只续期，时刻不变），
//   认得出"那一次请求"；发出时编辑权就交给了本页（reserved、free）、没有请求可认时不带；
// - 认（issuedHere）：编辑状态里有本人待回应的请求时要发出时刻对得上；有留给本人的保留时（请求交出之后转成了保留）有记号就算。
//   浏览器的"复制标签页"会连同 sessionStorage 一起复制，只看记号的话副本也认作发出过的那一页（M3-P5 复验 C2）：所以调用方（edit-request.ts
//   的 whose）另外要求本浏览器里没有页面持有"发出过请求"的锁（same-browser.ts），这里只管记号本身；
// - 读不出（隐私模式、被禁用、访问它就抛出）、认不出（别的版本的页面写的、被改过）时当作没有：按"不是这一页发出的"处理——宁可不恢复，
//   也不撤掉别处的请求；写不进去时什么也不做（这一页照常等，只是刷新之后不再恢复）。
// 不依赖 Univer 与界面；存储注入（组装处给出 sessionStorage），用假的做单元测试。
import type { MarkerStorage } from './pending-save-marker.ts'
import { z } from 'zod'

const KEY_PREFIX = 'nerve-office:edit-request:'

/** 记号的版本：认不出别的版本写的值时当作没有 */
const MARKER_VERSION = 1

/** 这一页发出过的请求：服务端给的发出时刻（发出时就交给了本页、没有请求可认时为 undefined） */
export interface IssuedRequest {
  readonly requestedAt: string | undefined
}

export interface IssuedRequestMarker {
  /** 记下（发出之后：在等待，或者编辑权交给了本页）；存储不可用时什么也不做 */
  readonly write: (requestedAt: string | undefined) => void
  /** 读出；没有、认不出、存储不可用时为 undefined */
  readonly read: () => IssuedRequest | undefined
  /** 清掉（请求结束、进入编辑、编辑状态里已经没有它）；存储不可用时什么也不做 */
  readonly clear: () => void
}

export interface IssuedRequestMarkerOptions {
  /** 取存储（window.sessionStorage）：取它本身就可能抛出（被禁用、沙箱），每次用时再取 */
  readonly storage: () => MarkerStorage
}

/** 编辑状态里本人的请求：待回应的请求的发出时刻（没有本人的请求时为 undefined）；有没有留给本人的保留 */
export interface MineRequest {
  readonly requestedAt: string | undefined
  readonly reserved: boolean
}

const storedSchema = z.object({
  v: z.literal(MARKER_VERSION),
  requestedAt: z.string().optional(),
})

export function issuedRequestKeyOf(documentId: string): string {
  return `${KEY_PREFIX}${documentId}`
}

/** 读出来的值认不出时当作没有（JSON 坏了、版本不同、字段不对） */
function parse(raw: string | null): IssuedRequest | undefined {
  if (raw === null)
    return undefined
  let data: unknown
  try {
    data = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  const parsed = storedSchema.safeParse(data)
  return parsed.success ? { requestedAt: parsed.data.requestedAt } : undefined
}

/**
 * 编辑状态里本人的请求是不是这一页发出的（见文件头）：有本人待回应的请求时要发出时刻对得上；有留给本人的保留时有记号就算；都没有时不是
 */
export function issuedHere(issued: IssuedRequest | undefined, mine: MineRequest): boolean {
  if (issued === undefined)
    return false
  if (mine.requestedAt !== undefined)
    return issued.requestedAt === mine.requestedAt
  return mine.reserved
}

export function issuedRequestMarker(documentId: string, options: IssuedRequestMarkerOptions): IssuedRequestMarker {
  const key = issuedRequestKeyOf(documentId)
  return {
    write: (requestedAt) => {
      try {
        options.storage().setItem(key, JSON.stringify(requestedAt === undefined ? { v: MARKER_VERSION } : { v: MARKER_VERSION, requestedAt }))
      }
      catch {
        // 存储不可用：这一页照常等，只是刷新之后不再恢复（见文件头）
      }
    },
    read: () => {
      try {
        return parse(options.storage().getItem(key))
      }
      catch {
        return undefined
      }
    },
    clear: () => {
      try {
        options.storage().removeItem(key)
      }
      catch {
        // 存储不可用：本来也没有记下
      }
    },
  }
}
