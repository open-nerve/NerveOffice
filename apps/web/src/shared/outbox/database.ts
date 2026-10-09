// 本机发件箱的库（M4-P1 设计 §3.3、§3.4.1）：IndexedDB 的库 nerve-office-outbox，两个对象仓库，键路径都是 ['userId', 'documentId']，
// 没有索引。某个用户的全部记录用键范围 [userId] 到 [userId, []] 取（IndexedDB 的键序里数组排在字符串之后）。
// 结构以后有变，只做加法的升级（加仓库、加索引），旧的页面打开更新过的库得到 VersionError，按"不可用"退化。
// 平台页面的列表标记（draft-index.ts）也引用这里：这个文件保持小，不引用别的模块
import type { DraftKey } from './draft-record.ts'

export const OUTBOX_DATABASE_NAME = 'nerve-office-outbox'

/** 库的版本：结构有变时加一，升级只做加法 */
export const OUTBOX_DATABASE_VERSION = 1

/** 草稿：StoredDraft */
export const DRAFTS_STORE = 'drafts'

/** 写入者：WriterRecord */
export const WRITERS_STORE = 'writers'

/** 两个仓库共用的键路径：记录里的 userId 与 documentId 就是它的键 */
export const OUTBOX_KEY_PATH: readonly (keyof DraftKey)[] = ['userId', 'documentId']

/**
 * 发件箱用不了的原因（§3.4.1）：调用方退化为内存实现，并如实说明（P2，US-M4-11）。
 * - unsupported：没有 IndexedDB，或者没有 crypto.subtle（非安全上下文）；
 * - denied：打不开（浏览器的策略禁止、私密模式的限制、磁盘出错）；
 * - newer-version：库被更新的页面升级过（VersionError）——本页过旧；
 * - blocked：升级被别的标签页挡住、等过了时限
 */
export type OutboxUnavailableReason = 'unsupported' | 'denied' | 'newer-version' | 'blocked'

export interface OutboxUnavailable {
  readonly kind: 'unavailable'
  readonly reason: OutboxUnavailableReason
}
