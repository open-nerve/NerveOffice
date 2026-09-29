import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'
import { codePointLength, hasControlCharacters } from '../text/text.ts'

/** 文件夹名称的上限（字符数，按码点计）。 */
export const FOLDER_NAME_MAX_LENGTH = 100

/**
 * 文件夹的最大层数（P4 设计 §3.3）：空间根目录下的文件夹是第 1 层。
 * 深度存在 folders.depth 列里，新建与移动时在事务里算好并校验，数据库另有 CHECK 兜底。
 */
export const FOLDER_MAX_DEPTH = 10

/** 列出一层时最多返回的条数（P4 设计 §3.2）：超过时只返回前这么多条，并给出 truncated。 */
export const FOLDER_LIST_MAX_ITEMS = 500

/**
 * 文件夹的名称：去掉首尾空白之后 1–100 个字符，不含控制字符。
 * 同一个文件夹里允许同名（M2 总设计 §6.8）：与团队空间的名称不同，这里没有唯一约束。
 */
export const folderNameSchema = z.string()
  .trim()
  .refine(value => codePointLength(value) >= 1 && codePointLength(value) <= FOLDER_NAME_MAX_LENGTH, `名称为 1–${FOLDER_NAME_MAX_LENGTH} 个字符`)
  .refine(value => !hasControlCharacters(value), '名称不能包含控制字符')

/** 路径里的文件夹 id。 */
export const folderIdSchema = uuidSchema

/**
 * 调用者在这个文件夹上能做的操作：界面据此只显示能做的，服务端按同一套规则检查（P4 设计 §3.7）。
 * 只列本 Step 已经提供的操作；删除随 P4 的 S3 加上自己的位与接口。
 */
export const folderPermissionsSchema = z.object({
  canRename: z.boolean(),
  /** 在同一个空间里换父文件夹：编辑者及以上 */
  canMoveWithinSpace: z.boolean(),
  /** 连同子树移到别的空间：源空间的空间管理员（目标空间的新建权限另判） */
  canMoveAcrossSpaces: z.boolean(),
})

export type FolderPermissions = z.infer<typeof folderPermissionsSchema>

/** 一个文件夹（列表的条目、新建与改动的响应）。响应的结构宽松，见 auth 的会话信息。 */
export const folderSchema = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  /** 父文件夹；在空间的根目录下时为 null */
  parentId: z.uuid().nullable(),
  name: z.string(),
  /** 第几层：空间根目录下的文件夹是 1，最深 FOLDER_MAX_DEPTH */
  depth: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  permissions: folderPermissionsSchema,
})

export type Folder = z.infer<typeof folderSchema>

/** 列出一层（GET /api/folders）：parentId 省略表示空间的根目录。 */
export const folderListQuerySchema = z.strictObject({
  spaceId: uuidSchema,
  parentId: uuidSchema.optional(),
})

export type FolderListQuery = z.infer<typeof folderListQuerySchema>

/** 一层里的文件夹，按名称排序；超过上限时只给前 FOLDER_LIST_MAX_ITEMS 条，truncated 为真。 */
export const folderListResponseSchema = z.object({
  items: z.array(folderSchema),
  truncated: z.boolean(),
})

export type FolderListResponse = z.infer<typeof folderListResponseSchema>

/**
 * 新建（POST /api/folders）。requestId 由客户端为每一次新建生成：网络错误后用同一个 requestId 重试，
 * 服务端只建一个。同一个文件夹里允许同名，重复的新建看名字分辨不出来，只能靠它（P4 设计 §3.2）。
 */
export const createFolderRequestSchema = z.strictObject({
  spaceId: uuidSchema,
  /** 建在哪个文件夹下；省略表示空间的根目录 */
  parentId: uuidSchema.optional(),
  name: folderNameSchema,
  requestId: uuidSchema,
})

export type CreateFolderRequest = z.input<typeof createFolderRequestSchema>

/**
 * 改名或移动（PATCH /api/folders/{id}）：parentId 为 null 表示移到空间的根目录，省略表示不移动；
 * 两项都省略时什么也不改。跨空间移动另有接口（P4 设计 §3.2）。
 */
export const updateFolderRequestSchema = z.strictObject({
  name: folderNameSchema.optional(),
  parentId: uuidSchema.nullable().optional(),
})

export type UpdateFolderRequest = z.input<typeof updateFolderRequestSchema>

/**
 * 连同子树移到某个空间的某个位置（POST /api/folders/{id}/move，P4 设计 §3.2）：
 * folderId 是目标空间里的父文件夹，省略表示那个空间的根目录（字段名与移动文档的接口一致，都是"目标位置"）。
 * 跨空间移动要源空间的空间管理员角色，并且在目标空间有新建权限（00 号计划书 §5.3）；
 * 目标就是文件夹现在所在的空间时，与空间内移动同一条规则（编辑者及以上），失败重试因此是幂等的。
 */
export const moveFolderRequestSchema = z.strictObject({
  spaceId: uuidSchema,
  folderId: uuidSchema.optional(),
})

export type MoveFolderRequest = z.input<typeof moveFolderRequestSchema>
