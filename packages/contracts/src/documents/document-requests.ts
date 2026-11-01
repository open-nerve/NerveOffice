import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'
import { clientFormatQueryShape } from './client-format.ts'
import { formulasPendingParam } from './content.ts'
import { DOCUMENT_TYPES, documentTitleSchema } from './documents.ts'

/**
 * 新建文档（POST /api/documents）。requestId 由客户端为每一次新建生成：网络错误后用同一个 requestId 重试，
 * 服务端只建一份（P4 设计 §3.4）。spaceId 是建在哪个空间（M2-P2），没有时建在本人的个人空间（M1 兼容）。
 * folderId 是建在那个空间里的哪个文件夹，省略表示空间的根目录（M2-P4）：
 * 在文件夹里新建因此是一步，不必"先建到根目录、再移进来"——两步之间失败会把文档留在别处。
 */
export const createDocumentRequestSchema = z.strictObject({
  type: z.enum(DOCUMENT_TYPES),
  title: documentTitleSchema.optional(),
  requestId: uuidSchema,
  spaceId: uuidSchema.optional(),
  folderId: uuidSchema.optional(),
})

export type CreateDocumentRequest = z.input<typeof createDocumentRequestSchema>

/**
 * 改名或在同一个空间里移动（PATCH /api/documents/{id}，M2-P4 设计 §3.2）：
 * folderId 为 null 表示移到空间的根目录，省略表示不移动；两项都省略时什么也不改。跨空间移动另有接口。
 */
export const updateDocumentRequestSchema = z.strictObject({
  title: documentTitleSchema.optional(),
  folderId: uuidSchema.nullable().optional(),
})

export type UpdateDocumentRequest = z.input<typeof updateDocumentRequestSchema>

/**
 * 移动到某个空间的某个位置（POST /api/documents/{id}/move，M2-P4 设计 §3.2）：folderId 省略表示那个空间的根目录。
 * 跨空间移动要源空间的空间管理员角色，并且在目标空间有新建权限（00 号计划书 §5.3）；
 * 目标就是文档现在所在的空间时，与空间内移动同一条规则（编辑者及以上），失败重试因此是幂等的。
 */
export const moveDocumentRequestSchema = z.strictObject({
  spaceId: uuidSchema,
  folderId: uuidSchema.optional(),
})

export type MoveDocumentRequest = z.input<typeof moveDocumentRequestSchema>

/**
 * 复制（POST /api/documents/{id}/copy，M2-P4 设计 §3.4 第 4 条）：复制到目标空间的某个位置（folderId 省略表示根目录）。
 * 标题省略时是 copiedDocumentTitle(源标题)。requestId 与新建文档一样做幂等：网络错误后用同一个 requestId 重试只复制一份。
 */
export const copyDocumentRequestSchema = z.strictObject({
  spaceId: uuidSchema,
  folderId: uuidSchema.optional(),
  title: documentTitleSchema.optional(),
  requestId: uuidSchema,
})

export type CopyDocumentRequest = z.input<typeof copyDocumentRequestSchema>

/**
 * 另存为副本（POST /api/documents/{id}/conflict-copies，M3-P2 设计 §3.2）的查询参数：正文是 gzip 压缩的快照
 * （SNAPSHOT_UPLOAD_CONTENT_TYPE，与保存同一个读取方式），元数据只能放在查询串里。
 * - requestId：与新建、复制一样做幂等，网络错误之后用同一个 requestId 重试只建一份；
 * - title：副本的标题，由页面给出（conflictCopyTitle：原标题加"（冲突副本 时间）"，时间按页面所在的时区）；
 * - formulasPending 与客户端的构建、数据格式：与保存相同，都可选（M3-P3 设计 §3.5、§3.8）。
 * 放在哪里不由请求决定：服务端按"本人在原文档所在的空间能不能新建"放进原文档所在的文件夹或本人的个人空间（00 号计划书 §7.5）
 */
export const conflictCopyQuerySchema = z.strictObject({
  requestId: uuidSchema,
  title: documentTitleSchema,
  formulasPending: formulasPendingParam,
  ...clientFormatQueryShape,
})

export type ConflictCopyQuery = z.output<typeof conflictCopyQuerySchema>
