// 比对 OPFS 镜像与库留下的提示（M4-P1 设计 §3.8）：本机草稿从备份恢复了（restored），或者因浏览器存储损坏丢失了（lost）。
// 存进库的 notices 仓库，键 [userId, documentId]，一份文档一条（后来的盖掉先前的）。restored 与写回草稿、写入者在同一个 strict 事务里写下，
// lost 另一个事务（draft-store.ts）。P3（打开文档时）、P4（本机草稿页）读出、说明之后清除；放弃、按用户清理与保留期一并清掉。
// 发件箱 Worker 也引用这个文件：不引用 zod
import type { DraftKey } from './draft-record.ts'
import { isFields, isText, isWhole } from './draft-record.ts'

export type RecoveryNoticeKind = 'restored' | 'lost'

export interface RecoveryNotice extends DraftKey {
  readonly kind: RecoveryNoticeKind
  /** 留下提示的时刻（墙上时间，毫秒）：保留期按它算；清除时带上它，免得清掉读出之后才留下的新提示 */
  readonly at: number
}

/** 库里读出的一条：形状不对的为 undefined（当作没有；清除、保留期照样删掉它）。交回的是只带约定字段的新对象 */
export function readRecoveryNotice(value: unknown): RecoveryNotice | undefined {
  if (!isFields(value))
    return undefined
  const { userId, documentId, kind, at } = value
  if (!isText(userId) || !isText(documentId) || (kind !== 'restored' && kind !== 'lost') || !isWhole(at, 0))
    return undefined
  return { userId, documentId, kind, at }
}
