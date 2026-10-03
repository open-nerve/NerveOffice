import type { DocumentType } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

/**
 * 请求负载的摘要（P4 设计 §3.5.3）：相同 requestId 的重试据此判断是不是同一个请求。
 * 以种类开头，新建与保存的摘要不会相同。
 */

/**
 * 新建：类型、实际使用的标题（没给标题时是默认标题），以及请求里指定的空间（M2-P2 设计 §3.6）与文件夹（M2-P4）。
 * 位置只按请求里给出的形式算，逐段往后加：两项都没给时与 M1 的摘要相同，只给空间时与 M2-P4 之前的相同，
 * 升级前后的重试照样按重放处理。标题不含控制字符（契约），所以按换行分段不会与标题混淆；
 * 只给文件夹时空间那一段留空，段数与内容仍然一一对应。id 已由契约统一成小写（M2-P2 审查 A1）。
 */
export function createdPayloadDigest(type: DocumentType, title: string, spaceId?: string, folderId?: string): Buffer {
  const parts = ['created', type, title]
  if (folderId !== undefined)
    parts.push(spaceId ?? '', folderId)
  else if (spaceId !== undefined)
    parts.push(spaceId)
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest()
}

/**
 * 复制（M2-P4）：源文档、目标位置与请求里给出的标题（没给时留空，副本的标题按源标题算出来）。
 * 只按请求里的东西算：源文档随后被改名，同一个 requestId 的重试照样按重放处理。
 */
export function copiedPayloadDigest(sourceId: string, spaceId: string, folderId: string | undefined, title: string | undefined): Buffer {
  return createHash('sha256').update(`copied\n${sourceId}\n${spaceId}\n${folderId ?? ''}\n${title ?? ''}`, 'utf8').digest()
}

/**
 * 新建文件夹（M2 Codex 评审 CX6）：请求里的空间、父文件夹（没给时留空）与名称（经契约规范化之后的，也就是存下的那个）。
 * 只按请求里的东西算，新建时存进 folders.payload_digest、之后不再改：建好之后改名、移动（同一个空间里、跨空间），
 * 同一个 requestId 的原样重试照样按重放处理。名称不含控制字符（契约），按换行分段不会与名称混淆；
 * id 已由契约统一成小写（M2-P2 审查 A1），与 PostgreSQL 的 uuid::text 写法相同。
 * 迁移 0021 按同一个写法在 SQL 里给已有的行回填（集成测试经接口原样重发迁移之前的新建请求，核对两边算的一致）：
 * 改这里的写法，已经存下的摘要就对不上了，要另加迁移
 */
export function folderCreatedPayloadDigest(spaceId: string, parentId: string | undefined, name: string): Buffer {
  return createHash('sha256').update(`folder-created\n${spaceId}\n${parentId ?? ''}\n${name}`, 'utf8').digest()
}

/** 保存：基准修订号与解压后的快照字节。按解压后的字节算，同一份内容重试时，客户端不必保证压缩结果逐字节相同。 */
export function savedPayloadDigest(baseRevision: number, raw: Buffer): Buffer {
  return createHash('sha256').update(`saved\n${baseRevision}\n`, 'utf8').update(raw).digest()
}
