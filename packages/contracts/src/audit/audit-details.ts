import type { AuditAction } from './audit.ts'
import { z } from 'zod'
import { LINK_INVALID_REASONS, ONE_TIME_LINK_PURPOSES } from '../auth/links.ts'
import { GRANT_ROLES } from '../sharing/sharing.ts'
import { SPACE_NAME_MAX_LENGTH, SPACE_ROLES } from '../spaces/spaces.ts'
import { codePointLength } from '../text/text.ts'
import { USER_SYSTEM_ROLES, USERNAME_PATTERN_SOURCE } from '../users/users.ts'

/**
 * 审计明细（details）按动作的严格结构（M2-P6 复核 M-1）：每个动作一个 strictObject，多一个键、少一个键、类型不对都拒绝。
 * 写审计（api 的 AuditService.record）按它校验；要给某个动作的明细加字段，先改这里（契约），审查时一眼看得到加了什么。
 *
 * 明细里只放定位与计数：对象的 id、原位置与目标位置（空间、文件夹的 id）、份数、原因、角色。
 * **不放文档标题、文件夹名称、正文、令牌与密码**（M2 总设计 §2.1 第 5 条、US-M2-13）：系统管理员能查审计，
 * 却看不到别人空间里的内容。团队空间的名称例外：系统管理员在管理界面本来就看得到全部团队空间的名称。
 */

const id = z.uuid()
/** 文件夹的位置：空表示空间的根目录 */
const folderPosition = z.uuid().nullable()
const count = z.int().nonnegative()
/** 这次失败使计数达到上限时，离解锁的秒数 */
const lockedForSeconds = z.int().nonnegative()
const username = z.string().regex(new RegExp(USERNAME_PATTERN_SOURCE))
/** 团队空间的名称（改名前后）：系统管理员在管理界面本来就看得到 */
const spaceName = z.string().refine(value => codePointLength(value) >= 1 && codePointLength(value) <= SPACE_NAME_MAX_LENGTH)
const spaceRole = z.enum(SPACE_ROLES)
/** 单独授权的角色（M2-P5）：查看者或编辑者 */
const grantRole = z.enum(GRANT_ROLES)
const systemRole = z.enum(USER_SYSTEM_ROLES)

/** 没有补充信息的动作 */
const none = z.strictObject({})

/**
 * 链接因为签发人离任而作废（M2-P6 复核 A2）：签发人被停用、签发人不再是系统管理员。
 * 停用账户、取消系统管理员时，在同一个事务里作废这个人签发给别人的、还没用的邀请与重置链接
 */
export const LINK_ISSUER_REVOCATION_REASONS = ['issuer_disabled', 'issuer_no_longer_admin'] as const
export type LinkIssuerRevocationReason = (typeof LINK_ISSUER_REVOCATION_REASONS)[number]
const issuerRevocation = z.enum(LINK_ISSUER_REVOCATION_REASONS)

/** 永久删除（人工与到期自动清理同一个形状）：这一单里的份数、删除单元，以及连带删掉的别的删除单元的个数 */
const purged = z.strictObject({
  spaceId: id,
  trashEntryId: id,
  folders: count,
  documents: count,
  cascadedEntries: count,
})

/** 恢复：恢复到的位置（文档所在、或文件夹的父文件夹），原位置不在时回到根目录 */
const restored = z.strictObject({
  spaceId: id,
  folderId: folderPosition,
  movedToRoot: z.boolean(),
  trashEntryId: id,
})

function entry<A extends AuditAction, D extends z.ZodType>(action: A, details: D) {
  return z.strictObject({ action: z.literal(action), details })
}

/**
 * 动作 → 明细的可辨识联合（按 action 区分）。AUDIT_ACTIONS 里的每个动作都要在这里有一项：
 * 类型上由下面的 EveryAuditActionHasDetails 检查，运行时由 audit-details.test.ts 检查。
 */
export const auditDetailsSchema = z.discriminatedUnion('action', [
  // M1
  entry('auth.login_succeeded', none),
  entry('auth.login_failed', z.strictObject({ reason: z.enum(['invalid_credentials', 'credentials_changed']), lockedForSeconds: lockedForSeconds.optional() })),
  entry('auth.logout', none),
  entry('users.admin_initialized', z.strictObject({ username })),
  entry('documents.created', z.strictObject({ revision: z.literal(1), folderId: folderPosition })),
  entry('documents.content_saved', z.strictObject({ revision: z.int().min(2) })),
  // M2-P1
  entry('auth.link_rejected', z.strictObject({ purpose: z.enum(ONE_TIME_LINK_PURPOSES), reason: z.enum(LINK_INVALID_REASONS) })),
  entry('users.invited', z.strictObject({ username, reissuedFrom: id.optional() })),
  // 手动作废没有明细；签发时自动作废过期的记 expired，重发时作废旧的记 reissued；签发人离任时作废的记原因（M2-P6 复核 A2）
  entry('users.invitation_revoked', z.union([
    none,
    z.strictObject({ expired: z.literal(true) }),
    z.strictObject({ reissued: z.literal(true) }),
    z.strictObject({ reason: issuerRevocation }),
  ])),
  entry('users.invitation_accepted', z.strictObject({ invitationId: id })),
  entry('users.password_changed', none),
  entry('users.password_change_failed', z.strictObject({ reason: z.enum(['current_password_incorrect', 'credentials_changed']), lockedForSeconds: lockedForSeconds.optional() })),
  entry('users.password_reset_issued', z.strictObject({ passwordResetId: id })),
  entry('users.password_reset_completed', z.strictObject({ passwordResetId: id })),
  entry('users.disabled', none),
  entry('users.enabled', none),
  entry('users.system_role_changed', z.strictObject({ from: systemRole, to: systemRole })),
  // M2-P2
  entry('spaces.created', z.strictObject({ adminUserId: id, visibleToAll: z.boolean() })),
  entry('spaces.renamed', z.strictObject({ from: spaceName, to: spaceName })),
  entry('spaces.visibility_changed', z.strictObject({ visibleToAll: z.boolean() })),
  entry('spaces.archived', none),
  entry('spaces.restored', none),
  entry('spaces.member_added', z.strictObject({ userId: id, role: spaceRole })),
  entry('spaces.member_role_changed', z.strictObject({ userId: id, from: spaceRole, to: spaceRole })),
  entry('spaces.member_removed', z.strictObject({ userId: id, role: spaceRole })),
  entry('spaces.admin_joined', z.strictObject({ role: spaceRole })),
  entry('documents.transferred', z.strictObject({ fromSpaceId: id, toSpaceId: id })),
  // M2-P4：文件夹。新建与改名只记位置，不记名称
  entry('folders.created', z.strictObject({ spaceId: id, parentId: folderPosition })),
  entry('folders.renamed', z.strictObject({ spaceId: id, parentId: folderPosition })),
  // 跨空间移动另记这次搬动的文件夹数与文档数
  entry('folders.moved', z.strictObject({
    fromSpaceId: id,
    fromParentId: folderPosition,
    toSpaceId: id,
    toParentId: folderPosition,
    folders: count.optional(),
    documents: count.optional(),
  })),
  // M2-P4：文档的整理。改名只记位置，不记改动前后的标题
  entry('documents.renamed', z.strictObject({ spaceId: id, folderId: folderPosition })),
  entry('documents.moved', z.strictObject({ fromSpaceId: id, fromFolderId: folderPosition, toSpaceId: id, toFolderId: folderPosition })),
  entry('documents.copied', z.strictObject({ sourceId: id, sourceSpaceId: id, spaceId: id, folderId: folderPosition })),
  // M2-P4 S3：回收站。永久删除只记份数与删除单元，不记标题与名称
  entry('documents.deleted', z.strictObject({ spaceId: id, folderId: folderPosition, trashEntryId: id })),
  entry('documents.restored', restored),
  entry('documents.purged', purged),
  entry('folders.deleted', z.strictObject({ spaceId: id, parentId: folderPosition, trashEntryId: id, folders: count, documents: count })),
  entry('folders.restored', restored),
  entry('folders.purged', purged),
  // M2-P6：重置链接被作废（签发新的时作废旧的、停用账户时作废未用的、签发人离任时作废他签发的），对象是被重置的账户（复核 C3、A2）
  entry('users.password_reset_revoked', z.strictObject({ passwordResetId: id, reason: z.enum(['reissued', 'account_disabled', ...LINK_ISSUER_REVOCATION_REASONS]) })),
  // M2-P6：系统管理员解除登录锁定，对象是这个账户（复核 A1）。清掉了哪些来源的计数不记：计数的键只存摘要，记下来也认不出来源
  entry('users.login_unlocked', none),
  // M2-P5：单独授权，对象是文档（不记标题）。与成员的三个动作同形：被授权人的 id 与角色，调整记前后的角色
  entry('documents.shared', z.strictObject({ userId: id, role: grantRole })),
  entry('documents.share_changed', z.strictObject({ userId: id, from: grantRole, to: grantRole })),
  entry('documents.share_revoked', z.strictObject({ userId: id, role: grantRole })),
  // M3-P2：另存为副本，对象是副本（M3-P2 设计 §3.2）。原文档与副本所在的空间（原文档所在的空间，或者本人的个人空间），不记标题
  entry('documents.conflict_copied', z.strictObject({ sourceId: id, spaceId: id })),
])

/** 一个动作与它的明细（解析之后） */
export type AuditActionDetails = z.output<typeof auditDetailsSchema>

/** 某个动作的明细（写入时的写法） */
export type AuditDetailsOf<A extends AuditAction> = Extract<z.input<typeof auditDetailsSchema>, { action: A }>['details']

/** 明细里没有必填字段的动作，写审计时可以不给 details（按空对象校验） */
type OptionalWhenEmpty<E> = E extends { action: infer A, details: infer D }
  ? (Record<string, never> extends D ? { action: A, details?: D } : { action: A, details: D })
  : never

/** 写审计时的动作与明细（按动作区分的联合） */
export type AuditActionDetailsInput = OptionalWhenEmpty<z.input<typeof auditDetailsSchema>>

type Expect<T extends true> = T
/** 编译期检查：AUDIT_ACTIONS 里的每个动作都有明细的结构，少了哪个，这里就编译不过 */
export type EveryAuditActionHasDetails = Expect<[Exclude<AuditAction, AuditActionDetails['action']>] extends [never] ? true : false>
