import { z } from 'zod'
import { DOCUMENT_TITLE_MAX_LENGTH } from '../documents/documents.ts'
import { uuidSchema } from '../ids/ids.ts'
import { userSummarySchema } from '../users/users.ts'

/**
 * 删除单元的种类（P4-S3 spec §1）：一份文档，或者一个文件夹连同它当时正常状态的整棵子树。
 * 新增取值时，同时用迁移更新 trash_entries.kind 的 CHECK 约束。
 */
export const TRASH_ENTRY_KINDS = ['document', 'folder'] as const
export type TrashEntryKind = (typeof TRASH_ENTRY_KINDS)[number]

/** 回收站里保留多少天（P4-S3 spec §1）：到期由 jobs 模块自动永久删除。 */
export const TRASH_RETENTION_DAYS = 30

/** 回收站列表每页的条数（keyset 分页，与文档列表同一个做法）。 */
export const TRASH_LIST_PAGE_SIZE = 50

/** 路径里的删除单元 id。 */
export const trashEntryIdSchema = uuidSchema

/**
 * 调用者在这个删除单元上能做的操作（P4-S3 spec §3、§4）：界面据此只显示能做的，服务端按同一套规则检查。
 * 看得到空间内容的人都看得到回收站的列表，但只有这两位能动它。
 */
export const trashPermissionsSchema = z.object({
  /** 恢复：删除者本人或当前的空间管理员（个人空间的所有者）；归档的空间里谁都不能 */
  canRestore: z.boolean(),
  /** 永久删除：空间管理员 / 个人空间的所有者；归档的空间里谁都不能 */
  canPurge: z.boolean(),
})

export type TrashPermissions = z.infer<typeof trashPermissionsSchema>

/**
 * 被删的那一个对象当时的位置（P4-S3 spec §3）：子孙的位置不单独记，它们跟着父辈。
 * available 为假时恢复会回到空间的根目录（原来的父文件夹被永久删除了，或者它自己也在回收站里）。
 */
export const trashOriginSchema = z.object({
  /** 原来的父文件夹；在空间的根目录下时为 null */
  parentId: z.uuid().nullable(),
  /** 原来的父文件夹的名称；在根目录下、或者它已经不在时为 null */
  parentName: z.string().nullable(),
  /** 原位置还在不在：假表示恢复会回到空间的根目录 */
  available: z.boolean(),
})

export type TrashOrigin = z.infer<typeof trashOriginSchema>

/** 回收站里的一个删除单元。响应的结构宽松，见 auth 的会话信息。 */
export const trashEntrySchema = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  kind: z.enum(TRASH_ENTRY_KINDS),
  /** 被删对象删除时的标题或名称 */
  title: z.string(),
  /** 删除的人；账户已经被清理掉时为 null（审计与本表都不随账户变化） */
  deletedBy: userSummarySchema.nullable(),
  deletedAt: z.iso.datetime(),
  /** 到期自动永久删除的时刻（删除时间加 TRASH_RETENTION_DAYS 天） */
  expiresAt: z.iso.datetime(),
  origin: trashOriginSchema,
  /** 这个删除单元里有多少份文档：一份文档的单元就是 1，文件夹的单元是整棵子树里的份数 */
  documentCount: z.number().int().min(0),
  permissions: trashPermissionsSchema,
})

export type TrashEntry = z.infer<typeof trashEntrySchema>

/** 按空间列出回收站（GET /api/trash）：删除时间从新到旧的 keyset 分页。 */
export const trashListQuerySchema = z.strictObject({
  spaceId: uuidSchema,
  cursor: z.string().min(1).max(512).optional(),
})

export type TrashListQuery = z.infer<typeof trashListQuerySchema>

/** 按删除时间从新到旧；还有下一页时给出游标。 */
export const trashListResponseSchema = z.object({
  items: z.array(trashEntrySchema),
  nextCursor: z.string().nullable(),
})

export type TrashListResponse = z.infer<typeof trashListResponseSchema>

/**
 * 恢复的结果（POST /api/trash/{entryId}/restore，P4-S3 spec §3）：整单回到正常状态，
 * 这里给出被删的那一个对象恢复之后的位置；movedToRoot 为真表示原位置已经不在，它回到了空间的根目录。
 */
export const restoredTrashEntrySchema = z.object({
  /** 被恢复的那个对象的 id：文档 id 或文件夹 id */
  id: z.uuid(),
  kind: z.enum(TRASH_ENTRY_KINDS),
  title: z.string().min(1).max(DOCUMENT_TITLE_MAX_LENGTH),
  spaceId: z.uuid(),
  /** 恢复到的文件夹；回到空间的根目录时为 null */
  folderId: z.uuid().nullable(),
  /** 原位置已经不在（被永久删除、自己也在回收站里、跨空间移动过），回到了空间的根目录 */
  movedToRoot: z.boolean(),
})

export type RestoredTrashEntry = z.infer<typeof restoredTrashEntrySchema>
