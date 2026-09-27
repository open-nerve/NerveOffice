import type { DocumentType } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

/**
 * 请求负载的摘要（P4 设计 §3.5.3）：相同 requestId 的重试据此判断是不是同一个请求。
 * 以种类开头，新建与保存的摘要不会相同。
 */

/** 新建：类型与实际使用的标题（没给标题时是默认标题）。 */
export function createdPayloadDigest(type: DocumentType, title: string): Buffer {
  return createHash('sha256').update(`created\n${type}\n${title}`, 'utf8').digest()
}

/** 保存：基准修订号与解压后的快照字节。按解压后的字节算，同一份内容重试时，客户端不必保证压缩结果逐字节相同。 */
export function savedPayloadDigest(baseRevision: number, raw: Buffer): Buffer {
  return createHash('sha256').update(`saved\n${baseRevision}\n`, 'utf8').update(raw).digest()
}
