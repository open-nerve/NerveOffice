import { z } from 'zod'

/**
 * 审计动作（规范 §7）。
 * 各 M 新增动作时，同时用迁移更新数据库的 CHECK 约束（audit_events.action），并在 audit-details.ts 里给出它的明细结构；
 * 已发布的动作不改名、不复用。每个动作的明细记什么见 audit-details.ts（不记文档标题与文件夹名称，M2-P6 复核 M-1）。
 */
export const AUDIT_ACTIONS = [
  // M1
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.logout',
  'users.admin_initialized',
  'documents.created',
  'documents.content_saved',
  // M2-P1：一次性链接不能用（没有这个令牌、过期、已用、已作废）；锁定期间只记日志
  'auth.link_rejected',
  // M2-P1：邀请注册、密码、账户的状态与系统角色
  'users.invited',
  'users.invitation_revoked',
  'users.invitation_accepted',
  'users.password_changed',
  // 修改密码时当前密码不对：与登录共用按用户名的计数，锁定时 details 带锁定秒数（审查 A6）
  'users.password_change_failed',
  'users.password_reset_issued',
  'users.password_reset_completed',
  'users.disabled',
  'users.enabled',
  'users.system_role_changed',
  // M2-P2：团队空间与成员。成员的变更以空间为对象，details 带成员的 id
  'spaces.created',
  'spaces.renamed',
  'spaces.visibility_changed',
  'spaces.archived',
  'spaces.restored',
  'spaces.member_added',
  'spaces.member_role_changed',
  'spaces.member_removed',
  // 系统管理员把自己加入团队空间：要看内容先加入，这个操作单独记（00 号计划书 §5.2）
  'spaces.admin_joined',
  // M2-P2：停用者个人空间的文档转移到别处；只改所属空间，不读内容，不记标题
  'documents.transferred',
  // M2-P4：文件夹。details 只有位置（空间与父文件夹），不记名称（M2-P6 复核 M-1）
  'folders.created',
  'folders.renamed',
  'folders.moved',
  // M2-P4：文档的整理。改名只记位置、不记标题；移动记原位置与目标位置（空间与文件夹）；复制记源文档
  'documents.renamed',
  'documents.moved',
  'documents.copied',
  // M2-P4 S3：回收站。删除记原位置与删除单元；恢复记恢复到的位置与是否回落到根目录；
  // 永久删除记这一单里的份数与连带删除的单元，不记标题与名称（到期自动清理时操作者是系统，actor_type = 'system'）
  'documents.deleted',
  'documents.restored',
  'documents.purged',
  'folders.deleted',
  'folders.restored',
  'folders.purged',
  // M2-P6：重置链接被作废（签发新的时作废旧的、停用账户时作废未用的、签发人被停用或不再是系统管理员），与邀请的作废对应（复核 C3、A2）
  'users.password_reset_revoked',
  // M2-P6：系统管理员解除某个账户的登录锁定，清掉这个账户在所有来源上的失败计数（复核 A1）
  'users.login_unlocked',
  // M2-P5：单独授权（分享）的设置、调整与取消。对象是文档，details 带被授权人的 id 与角色，不记标题（与成员的三个动作同形）
  'documents.shared',
  'documents.share_changed',
  'documents.share_revoked',
  // M3-P2：另存为副本（失去编辑权时把本页的内容存成一份新文档）。对象是副本，details 带原文档与副本所在的空间，不记标题
  'documents.conflict_copied',
] as const

export const auditActionSchema = z.enum(AUDIT_ACTIONS)

export type AuditAction = z.infer<typeof auditActionSchema>

/** 操作者：用户、系统（例如命令行初始化管理员）、未登录的访问者（例如登录失败）。 */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'anonymous'] as const

/** 操作的对象。新增取值时，同时用迁移更新 CHECK 约束（audit_events.target_type）。 */
export const AUDIT_TARGET_TYPES = ['user', 'space', 'document', 'invitation', 'folder', 'trash_entry'] as const

/**
 * 来源：HTTP 请求、命令行，或应用自己的定时任务（M2-P4 S4 的回收站清理）。
 * 新增取值时，同时用迁移更新 CHECK 约束（audit_events.source）。
 */
export const AUDIT_SOURCES = ['http', 'cli', 'job'] as const

/**
 * 补充信息（details）按 JSON 文本计的上限（字节）。按动作的结构（audit-details.ts）里每个字段都有上界，
 * 最长的也在它之内（audit-details.test.ts 核对）；数据库的 CHECK 按它留出余量兜底。
 */
export const AUDIT_DETAILS_MAX_BYTES = 4096
