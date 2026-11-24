// 当前 Document 明确发出过的编辑请求。服务端 request/reservation 按人归属，不能证明是哪个页面发出。
// sessionStorage 与空闲的本机锁都可能来自延迟副本，因此不再跨 Document 恢复等待意图（M4-P3 S5）。
// 新对象只在内存中记下本页 send 的结果；重载/副本重新点击“请求编辑”或“编辑”后才参与等待与交接。
// 旧版 sessionStorage 仅按文档清理。清理失败不影响当前页的明确操作，也绝不退回读取旧记号。
import type { MarkerStorage } from './pending-save-marker.ts'

const KEY_PREFIX = 'nerve-office:edit-request:'

/** 本页发出时服务端给的时刻；发出时就交给了本页时没有时刻 */
export interface IssuedRequest {
  readonly requestedAt: string | undefined
}

export interface IssuedRequestMarker {
  /** 当前页面明确发出之后记下，不写入任何浏览器存储 */
  readonly write: (requestedAt: string | undefined) => void
  readonly read: () => IssuedRequest | undefined
  readonly clear: () => void
}

export interface IssuedRequestMarkerOptions {
  /** 仅用于迁移清理，取得存储或删除均可能抛出 */
  readonly storage: () => Pick<MarkerStorage, 'removeItem'>
}

/** 服务端按人记录的待回应请求或保留，不能单独作为当前页意图 */
export interface MineRequest {
  readonly requestedAt: string | undefined
  readonly reserved: boolean
}

export function issuedRequestKeyOf(documentId: string): string {
  return `${KEY_PREFIX}${documentId}`
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
  try {
    options.storage().removeItem(issuedRequestKeyOf(documentId))
  }
  catch {
    // 迁移清理失败：从不读取旧值，仍以新的内存对象开始。
  }
  let issued: IssuedRequest | undefined
  return {
    write: (requestedAt) => { issued = { requestedAt } },
    read: () => issued,
    clear: () => { issued = undefined },
  }
}
