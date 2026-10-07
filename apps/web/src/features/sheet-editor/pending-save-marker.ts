// 刷新时在途的保存的记号（M3-P5 设计 §3.7 的 R1）：本页关闭（pagehide）时有保存在途，按 M3-P4 不释放编辑权，让那次保存能提交；P5 的本人接管
// 会立即结束旧的一代，那次保存要是还在服务端检查快照、等锁，就会被挡掉，旧页面已经没了，修改无声丢失。所以那时在 localStorage 记下这份文档
// 有一次保存可能还在服务端处理（何时、它的基准修订号）；同一个浏览器里新载入的页面本人接管之前看到 30 秒内的记号就先等它（S6），接手之后清掉。
// 记号只在同一个浏览器里起作用，正好覆盖这个情形（跨设备的旧页面还在，被接管之后自己给副本）。
// - 键 nerve-office:pending-save:<documentId>；值带版本，读出来认不出（别的版本的页面写的、被改过）就当作没有；
// - 时刻用墙上时间（Date.now）：要在另一个页面里比较，performance.now 各页面各算各的；
// - localStorage 不可用（隐私模式、被禁用、访问它就抛出、配额满）时什么也不做：退回立即接手（已知限制，设计 §7）。
// 不依赖 Univer 与界面；存储与时钟注入（组装处给出 localStorage 与 Date.now），用假的做单元测试。
import { z } from 'zod'

const KEY_PREFIX = 'nerve-office:pending-save:'

/** 记号的版本：认不出别的版本写的值时当作没有 */
const MARKER_VERSION = 1

/** 一份文档的记号 */
export interface PendingSave {
  /** 记下的时刻（墙上时间，毫秒） */
  readonly at: number
  /** 那次保存的基准修订号（本页当时确认过的最新修订）：编辑状态里的修订号比它新，就是那次（或者之后别的）保存提交了 */
  readonly revision: number
}

export interface PendingSaveMarker {
  /** 记下（pagehide 时保存忙）：同步写；存储不可用时什么也不做 */
  readonly write: (revision: number) => void
  /** 读出；没有、认不出、存储不可用时为 undefined */
  readonly read: () => PendingSave | undefined
  /** 清掉（接手之后，S6）；存储不可用时什么也不做 */
  readonly clear: () => void
}

/** localStorage 用到的部分 */
export interface MarkerStorage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
  readonly removeItem: (key: string) => void
}

export interface PendingSaveMarkerOptions {
  /** 取存储（window.localStorage）：取它本身就可能抛出（被禁用、沙箱），每次用时再取 */
  readonly storage: () => MarkerStorage
  /** 现在的墙上时间（Date.now） */
  readonly now: () => number
}

const storedSchema = z.object({
  v: z.literal(MARKER_VERSION),
  at: z.number().int().nonnegative(),
  revision: z.number().int().min(1),
})

export function keyOf(documentId: string): string {
  return `${KEY_PREFIX}${documentId}`
}

/** 读出来的值认不出时当作没有（JSON 坏了、版本不同、字段不对） */
function parse(raw: string | null): PendingSave | undefined {
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
  return parsed.success ? { at: parsed.data.at, revision: parsed.data.revision } : undefined
}

export function pendingSaveMarker(documentId: string, options: PendingSaveMarkerOptions): PendingSaveMarker {
  const key = keyOf(documentId)
  return {
    write: (revision) => {
      try {
        options.storage().setItem(key, JSON.stringify({ v: MARKER_VERSION, at: options.now(), revision }))
      }
      catch {
        // 存储不可用：退回立即接手（见文件头）
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
