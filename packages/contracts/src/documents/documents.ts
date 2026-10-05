import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'
import { codePointLength, titleTextSchema } from '../text/text.ts'
import { clientFormatQueryShape } from './client-format.ts'
import { formulasPendingParam } from './content.ts'

/** 文档类型：M1 只有表格，M6 加上文字文档（doc）。新增取值时，同时用迁移更新 documents.type 的 CHECK 约束。 */
export const DOCUMENT_TYPES = ['sheet'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/**
 * 文档状态：正常；在回收站里（M2-P4：随删除单元一起进回收站，30 天后永久删除）。
 * 文件夹用同一组状态（folders.status）。新增取值时，同时用迁移更新两张表 status 的 CHECK 约束。
 */
export const DOCUMENT_STATUSES = ['active', 'trashed'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/**
 * 插件档案（00 号计划书 §8.2）：一种文档类型固定使用的插件、注册顺序与影响数据的配置，标识带版本。
 * 新增取值时，同时用迁移更新 documents.profile 的 CHECK 约束；已有的档案不改内容，变更就发新版本。
 */
export const DOCUMENT_PROFILES = ['sheet@1'] as const
export type DocumentProfile = (typeof DOCUMENT_PROFILES)[number]

/** 新建各类型的文档时使用的档案。 */
export const DOCUMENT_PROFILE_OF: Readonly<Record<DocumentType, DocumentProfile>> = { sheet: 'sheet@1' }

/**
 * 平台格式版本（00 号计划书 §8.1）：本平台快照信封的格式，与 SDK 版本独立。
 * 新增取值时，同时用迁移更新 documents.format_version 的 CHECK 约束。
 */
export const PLATFORM_FORMAT_VERSIONS = [1] as const
export type PlatformFormatVersion = (typeof PLATFORM_FORMAT_VERSIONS)[number]

/** 新写入的文档使用的格式版本。 */
export const PLATFORM_FORMAT_VERSION: PlatformFormatVersion = 1

/** 标题的上限（字符数，按码点计）。 */
export const DOCUMENT_TITLE_MAX_LENGTH = 200

/** 新建时没有给标题，用这个。 */
export const DEFAULT_DOCUMENT_TITLES: Readonly<Record<DocumentType, string>> = { sheet: '未命名表格' }

/** 复制出来的文档，标题在源标题后面加这一段（M2-P4 设计 §3.4 第 4 条）。 */
export const COPIED_TITLE_SUFFIX = ' 的副本'

/**
 * 复制时没有指定标题，用这个：源标题加上"的副本"。
 * 加完超过上限时按码点截断源标题（不截成半个字符），再去掉截断处留下的空白；界面与服务端共用这一条规则。
 */
export function copiedDocumentTitle(sourceTitle: string): string {
  return withTitleSuffix(sourceTitle, COPIED_TITLE_SUFFIX)
}

/**
 * 另存为副本（M3-P2 设计 §3.2，00 号计划书 §7.5）的标题：原标题后面加"（冲突副本 <label>）"。
 * label 是页面按所在的时区写到分钟的时间（例如 2026-10-04 14:30）：服务端不知道页面的时区，标题由页面给出。
 * 加完超过上限时按码点截断原标题、去掉截断处留下的空白（与 copiedDocumentTitle 同一个写法），结果一定不超过上限。
 * label 长得连原标题一个字也放不下（后缀本身超过上限）是调用方写错了，抛 RangeError，不交出一个服务端会拒绝的标题
 */
export function conflictCopyTitle(sourceTitle: string, label: string): string {
  const suffix = `（冲突副本 ${label}）`
  if (codePointLength(suffix) > DOCUMENT_TITLE_MAX_LENGTH)
    throw new RangeError(`冲突副本的时间太长，标题放不下：${codePointLength(label)} 个字符`)
  return withTitleSuffix(sourceTitle, suffix)
}

/** 原标题加上后缀；加完超过上限时按码点截断原标题（不截成半个字符），再去掉截断处留下的空白 */
function withTitleSuffix(sourceTitle: string, suffix: string): string {
  const room = DOCUMENT_TITLE_MAX_LENGTH - codePointLength(suffix)
  const points = [...sourceTitle]
  const base = points.length > room ? points.slice(0, room).join('').trimEnd() : sourceTitle
  return `${base}${suffix}`
}

/**
 * 标题：标题的共用规则（text.ts 的 titleTextSchema），去掉首尾空白之后 1–200 个字符。标题是用户的内容，比名称宽：
 * 原样保存（不做 NFC 归一），只拒绝控制字符、改变文字方向的字符与换行符，并要求不能只有看不见的字符（M2-P6 复核 B2）
 */
export const documentTitleSchema = titleTextSchema({ label: '标题', maxLength: DOCUMENT_TITLE_MAX_LENGTH })

export const DOCUMENT_LIST_DEFAULT_LIMIT = 50
export const DOCUMENT_LIST_MAX_LIMIT = 100

/** folderId 的这个取值表示"整个空间，不按目录过滤"（P4 设计 §3.2）；不是 UUID，与文件夹 id 不会混淆。 */
export const DOCUMENT_LIST_ALL_FOLDERS = 'all'

/**
 * 列表的查询参数：按哪个空间、哪个文件夹列出，每页条数与上一页给出的游标（不透明的字符串）。
 * 没有 spaceId 时是本人的个人空间（M1 兼容，M2 总设计 §6.4）。
 * folderId 省略表示空间的根目录（M2-P4 之前的行为：那时全部文档都在根目录），all 表示整个空间不按目录过滤。
 */
export const documentListQuerySchema = z.strictObject({
  spaceId: uuidSchema.optional(),
  folderId: z.union([z.literal(DOCUMENT_LIST_ALL_FOLDERS), uuidSchema]).optional(),
  limit: z.coerce.number().int().min(1).max(DOCUMENT_LIST_MAX_LIMIT).default(DOCUMENT_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
})

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>

/** 文档的摘要：列表的条目。时间是 ISO 8601 的 UTC（规范 §4）。响应的结构宽松，见 auth 的会话信息。 */
export const documentSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  type: z.enum(DOCUMENT_TYPES),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type DocumentSummary = z.infer<typeof documentSummarySchema>

/** 按更新时间从新到旧；还有下一页时给出游标。 */
export const documentListResponseSchema = z.object({
  items: z.array(documentSummarySchema),
  nextCursor: z.string().nullable(),
})

export type DocumentListResponse = z.infer<typeof documentListResponseSchema>

/**
 * 文档所在的空间（文档详情的 space）：编辑器页的返回链接回到这里（M2-P2 设计 §3.10）。
 * - 团队空间：id、类型与名称；
 * - 个人空间：只有 id 与类型（M2-P5）。存的名称是所有者建号时的显示名，可以伪造（规范 §2.4），详情也用不着它：
 *   在个人空间里有角色的只有所有者自己，界面写"我的空间"；只凭授权打开的（accessVia 为 grant）返回"与我共享"。
 *   documents 模块拿不到人名，这里也就不给所有者。
 * 响应的结构宽松（见 auth 的会话信息）：服务端多给的字段在客户端被丢弃
 */
export const documentSpaceSchema = z.discriminatedUnion('type', [
  z.object({ id: z.uuid(), type: z.literal('team'), name: z.string() }),
  z.object({ id: z.uuid(), type: z.literal('personal') }),
])

export type DocumentSpace = z.infer<typeof documentSpaceSchema>

/**
 * 调用者看得到这份文档的途径（M2-P5 设计 §3.4(1)）：
 * - space：在它所在的空间里有角色（可能另外还有单独授权，权限取较高者）；
 * - grant：在那个空间里没有角色，只凭单独授权。这时看不到空间的目录结构（00 号计划书 §5.5）：
 *   详情与搜索结果都不带所在的文件夹，移动、删除、分享这些结构性的操作一律不能做。
 */
export const DOCUMENT_ACCESS_VIA = ['space', 'grant'] as const
export type DocumentAccessVia = (typeof DOCUMENT_ACCESS_VIA)[number]

/**
 * 调用者在这份文档上能做的操作：界面据此只显示能做的，服务端按同一套规则检查（M2-P4 设计 §3.7）。
 * 内容的操作（保存、改名、复制）看内容权限——空间角色与单独授权取较高者；结构性的操作（移动、删除、分享）只看空间角色，
 * 只凭授权的人一律没有（M2-P5 设计 §3.4(1)）。归档的空间里所有人至多是查看者，包括被单独授权为编辑者的人。
 */
export const documentPermissionsSchema = z.object({
  /** 改动内容（保存）：内容权限是编辑者及以上 */
  canEdit: z.boolean(),
  /** 改名：与保存同一条规则 */
  canRename: z.boolean(),
  /** 在同一个空间里换文件夹：空间角色是编辑者及以上 */
  canMoveWithinSpace: z.boolean(),
  /** 移到别的空间：源空间的空间管理员（目标空间的新建权限另判） */
  canMoveAcrossSpaces: z.boolean(),
  /** 复制：能读就能复制（目标空间的新建权限另判） */
  canCopy: z.boolean(),
  /** 删除（进回收站）：空间管理员任意，空间角色是编辑者的只能删自己创建的（P4-S3 spec §2） */
  canDelete: z.boolean(),
  /** 分享（查看、设置、调整、取消这份文档的单独授权）：空间管理员或个人空间的所有者；归档的空间里没有（M2-P5） */
  canShare: z.boolean(),
})

export type DocumentPermissions = z.infer<typeof documentPermissionsSchema>

/**
 * 文档的元数据与调用者的权限（GET /api/documents/{id}，新建、改动与复制的响应）。
 * 档案、格式版本与 SDK 版本不按已知的取值校验：客户端自己核对，不认识的显示"格式不受支持"，而不是当作响应不合法（P4 设计 §3.7.1）。
 */
export const documentDetailSchema = documentSummarySchema.extend({
  spaceId: z.uuid(),
  space: documentSpaceSchema,
  /**
   * 所在的文件夹；在空间的根目录下时为 null（M2-P4）。
   * 只凭单独授权（accessVia 为 grant）时一律为 null：所在的文件夹是空间目录结构的一部分（M2-P5）
   */
  folderId: z.uuid().nullable(),
  /** 看得到它的途径：只凭授权时界面不显示所在位置、没有移动与删除的入口（M2-P5） */
  accessVia: z.enum(DOCUMENT_ACCESS_VIA),
  /** 当前修订号：新建为 1，每次保存加一 */
  revision: z.number().int().min(1),
  profile: z.string().min(1),
  formatVersion: z.number().int().min(1),
  /**
   * 最后一次写入这份文档的 SDK 版本（documents.sdk_version，M3-P3 设计 §3.5）：比本页的 SDK 新时，这份文档由更新的版本保存过
   * （服务端回滚之后），页面一开始就只能阅读（DOCUMENT_TOO_NEW）
   */
  sdkVersion: z.string().min(1),
  /**
   * "公式待更新"（M3-P3 设计 §3.8）：最近一次写入的快照里公式结果可能还没算完。P4 据此在进入编辑时先全量重算、阅读页给出说明。
   * 存量一律没有标记
   */
  formulasPending: z.boolean(),
  permissions: documentPermissionsSchema,
})

export type DocumentDetail = z.infer<typeof documentDetailSchema>

/**
 * 带 requestId 的新建与复制的响应（POST /api/documents、POST /api/documents/{id}/copy，M3-P2 起另存为副本
 * POST /api/documents/{id}/conflict-copies 同样）：文档的元数据，加上这次是不是重放
 * （M2-P6 复核第二批 S-1，接口的加法）。replayed 为真：同一个 requestId 的那一次之前已经建好了，这次没有新建，给出的是那一份现在的样子
 * （可能已经改了名、移了位置）。客户端据此说明"上一次其实已经完成"，不把它当成这一次新建的，这件事随之了结——
 * 之后再点就是另一件事、另一个 requestId（否则结果未知之后留着的 requestId 会把很久以后的"再建一份"当成重试）
 */
export const createdDocumentSchema = documentDetailSchema.extend({
  replayed: z.boolean(),
})

export type CreatedDocument = z.infer<typeof createdDocumentSchema>

/** 路径里的文档 id。 */
export const documentIdSchema = uuidSchema

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
