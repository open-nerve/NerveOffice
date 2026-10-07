// 有效权限的规则（00 号计划书 §5.2、§5.3，M2-P2 设计 §3.4，M2-P5 设计 §3.4(1)）：只按事实计算，不查询。
// 访问策略（document-access-policy.ts）取事实、调用这里；服务不自己拼权限条件（M2 总设计 §6.1）。
import type { DocumentAccessVia, DocumentPermissions, FolderPermissions, GrantRole, SpacePermissions, SpaceRole, TrashPermissions } from '@nerve-office/contracts'
import type { SpaceFacts } from '../spaces/index.ts'
import { SPACE_ROLES } from '@nerve-office/contracts'

/** 判断"能不能删这份文档"要用到的属性：创建人（编辑者只能删自己创建的，P4-S3 spec §2）。 */
export interface DocumentOwnership {
  readonly createdBy: string
}

/** role 至少是 least（角色按查看者、编辑者、空间管理员从低到高）。 */
export function atLeast(role: SpaceRole, least: SpaceRole): boolean {
  return SPACE_ROLES.indexOf(role) >= SPACE_ROLES.indexOf(least)
}

/** 两个角色里较高的一个；只有一个时就是它，都没有时为 undefined */
function higherOf(first: SpaceRole | undefined, second: SpaceRole | undefined): SpaceRole | undefined {
  if (first === undefined || second === undefined)
    return first ?? second
  return atLeast(first, second) ? first : second
}

/**
 * 归档的空间里所有人至多是查看者（00 号计划书 §5.2）。空间角色与单独授权都经这一处降级：
 * 被单独授权为编辑者的人在归档的空间里同样只是查看者（M2-P5 设计 §1、§7）
 */
function cappedByStatus(space: SpaceFacts, role: SpaceRole | undefined): SpaceRole | undefined {
  return role !== undefined && space.status === 'archived' ? 'viewer' : role
}

/**
 * 一个人在一个空间里的有效角色；没有任何角色时为 undefined。
 * - 个人空间：所有者是空间管理员，其他人（包括系统管理员）都没有角色；个人空间的成员行一概不计。
 * - 团队空间：成员的角色；全员可见时，任何有效账户至少是查看者；归档时所有人至多是查看者。
 * 单独授权不在这里：它不给空间里的任何东西开口子（空间页、按空间列出、文件夹、回收站都只看它，M2-P5 设计 §3.4(1)）
 */
export function effectiveSpaceRole(space: SpaceFacts): SpaceRole | undefined {
  if (space.type === 'personal')
    return space.owned ? 'admin' : undefined
  // 查看者是最低的角色：成员的角色与"全员可见的查看者"取较高者，就是有成员角色时取成员角色
  return cappedByStatus(space, space.memberRole ?? (space.visibleToAll ? 'viewer' : undefined))
}

/**
 * 空间恢复之后（不再归档）这个人的空间角色，也就是归档之前的空间角色（成员的角色、全员可见给的查看者；个人空间的所有者是空间管理员）。
 * 只用于给说明，不给任何权限：归档的空间里分享冻结，冻结的说明（"恢复之后才能调整分享"）许诺了恢复之后的能力，
 * 只给恢复之后确实能做的人（M2-P5 审查 A 的一般 6、B 的 G1）
 */
export function spaceRoleOnceRestored(space: SpaceFacts): SpaceRole | undefined {
  return effectiveSpaceRole({ ...space, status: 'active' })
}

/** 分享的规则：空间角色是空间管理员（个人空间的所有者也是）。documentPermissionsOf 的 canShare 与"恢复之后能不能分享"共用这一处 */
function sharesAs(spaceRole: SpaceRole | undefined): boolean {
  return spaceRole === 'admin'
}

/**
 * 归档的空间恢复之后，这个人能不能分享这个空间里的文档：按归档之前的空间角色——空间管理员与个人空间的所有者能，
 * 空间里的编辑者、查看者（含全员可见给的）不能，只凭授权的人也不能（他没有空间角色）。只用于给说明（见 spaceRoleOnceRestored）
 */
export function canShareOnceRestored(space: SpaceFacts): boolean {
  return sharesAs(spaceRoleOnceRestored(space))
}

/**
 * 调用者对一份文档的访问（M2-P5 设计 §3.4(1)）：空间角色与内容权限分开带——只按一个角色推，只凭授权的编辑者就会拿到
 * 移动与删除的权限、详情还带着所在的文件夹（M2-P6 复核 S2 的 M1）。
 */
export interface DocumentAccess {
  /** 空间角色（effectiveSpaceRole，已按归档降级）；结构性的操作只看它。只凭授权时为 undefined */
  readonly spaceRole: SpaceRole | undefined
  /** 内容权限：空间角色与单独授权取较高者（授权最高只到编辑者），归档的空间里同样至多是查看者；能读、能保存、能改名看它 */
  readonly contentRole: SpaceRole
  /** 看得到它的途径：没有空间角色、只凭授权时是 grant——这时不给空间的目录结构（document-views.ts 的 toDetail） */
  readonly accessVia: DocumentAccessVia
  /** 文档所在的空间 */
  readonly space: SpaceFacts
}

/**
 * 一个人对所在空间是 space 的一份文档的访问：空间的事实与他在这份文档上的单独授权（没有时为 undefined）。
 * 两样都没有时为 undefined：调用方按不存在回答（NOT_FOUND）。只有这一处把空间角色与授权合起来（M2 总设计 §6.1）
 */
export function documentAccessOf(space: SpaceFacts, grant: GrantRole | undefined): DocumentAccess | undefined {
  const spaceRole = effectiveSpaceRole(space)
  // 取较高者之后再按归档降级：授权本身不知道空间归档了没有
  const contentRole = cappedByStatus(space, higherOf(spaceRole, grant))
  if (contentRole === undefined)
    return undefined
  return { spaceRole, contentRole, accessVia: spaceRole === undefined ? 'grant' : 'space', space }
}

/**
 * 在这个空间里能做的操作（M2-P2 设计 §3.4 的操作规则）。role 是有效角色（已按归档降级）。
 * 系统角色只影响团队空间的管理操作（查看与管理成员、改名），不带来任何内容权限。
 */
export function spacePermissionsOf(space: SpaceFacts, role: SpaceRole | undefined, systemAdmin: boolean): SpacePermissions {
  const team = space.type === 'team'
  // 归档的空间里有效角色至多是查看者，所以这里的空间管理员一定是没有归档的空间里的
  const spaceAdmin = role === 'admin'
  // 在空间里放东西：新建文档与新建文件夹同一条规则（M2-P4 设计 §3.7）
  const canCreate = role !== undefined && atLeast(role, 'editor')
  return {
    canCreateDocuments: canCreate,
    canCreateFolders: canCreate,
    canViewMembers: team && (role !== undefined || systemAdmin),
    canManageMembers: team && (spaceAdmin || systemAdmin),
    canRename: team && (spaceAdmin || systemAdmin),
    // 永久删除回收站里的删除单元：空间管理员，个人空间的所有者有效角色也是空间管理员（M2-P4 设计 §3.7）
    canPurgeTrash: spaceAdmin,
  }
}

/**
 * 在一份文档上能做的操作（00 号计划书 §5.3，M2-P4 设计 §3.7，M2-P5 设计 §3.4(1)）。access 由访问策略给出（documentAccessOf）；
 * 能拿到它就说明看得到这份文档。两组权限位分开算：
 * - 内容（保存、改名、复制）看 contentRole：空间角色与单独授权取较高者；
 * - 结构（空间内移动、跨空间移动、删除、分享）只看 spaceRole：只凭授权的人看不到空间的目录结构，这几项一律没有
 *   （00 号计划书 §5.3 补充说明与 §5.5，需求方 2026-10-01 确认只凭授权的人也不能删除）；
 * - 强制接管（M3-P5 设计 §3.8）两样都看：空间角色是空间管理员，并且能编辑。
 * 两个角色都已按归档降级，所以归档的空间里只剩复制。
 */
export function documentPermissionsOf(access: DocumentAccess, document: DocumentOwnership, userId: string): DocumentPermissions {
  const contentEditor = atLeast(access.contentRole, 'editor')
  const structureEditor = access.spaceRole !== undefined && atLeast(access.spaceRole, 'editor')
  const spaceAdmin = access.spaceRole === 'admin'
  return {
    canEdit: contentEditor,
    canRename: contentEditor,
    // 能读就能复制（目标空间的新建权限另判）：查看者、归档空间里的成员、只凭授权的人也可以
    canCopy: true,
    canMoveWithinSpace: structureEditor,
    // 跨空间移动要源空间的空间管理员（目标空间的新建权限另判）
    canMoveAcrossSpaces: spaceAdmin,
    // 删除（进回收站）：空间管理员任意，空间角色是编辑者的只能删自己创建的（P4-S3 spec §2）
    canDelete: spaceAdmin || (structureEditor && document.createdBy === userId),
    // 分享：空间管理员或个人空间的所有者（有效角色都是空间管理员），归档的空间里没有（M2-P5 设计 §3.2）
    canShare: sharesAs(access.spaceRole),
    // 强制接管别人的编辑（M3-P5 设计 §3.8）：空间管理员或个人空间的所有者（有效角色都是空间管理员），并且能编辑。
    // 归档的空间里空间角色已降为查看者、只凭授权的人没有空间角色，都没有。今天空间管理员一定能编辑，"能编辑"是纵深防御：
    // 接管就是取得编辑权，不能编辑的人不该因为别的权限位拿到它
    canTakeOver: spaceAdmin && contentEditor,
  }
}

/**
 * 在一个文件夹上能做的操作（M2-P4 设计 §3.7）。v0.1 的权限只到空间与文档两级，文件夹没有自己的权限，
 * 所以只看调用者在这个空间里的有效角色（已按归档降级）。
 */
export function folderPermissionsOf(role: SpaceRole | undefined): FolderPermissions {
  const editor = role !== undefined && atLeast(role, 'editor')
  return {
    canRename: editor,
    canMoveWithinSpace: editor,
    // 连同子树移出本空间要空间管理员（目标空间的新建权限另判），与文档一致；归档的空间里有效角色至多是查看者
    canMoveAcrossSpaces: role === 'admin',
    // 编辑者及以上能删；"子树里正常状态的文档全部是本人创建的"这一条不在这里，
    // 在锁下用一条计数语句判断（P4-S3 spec §2）：展开子树之后可能有人往里移进别人的文档
    canDelete: editor,
  }
}

/**
 * 在回收站里的一个删除单元上能做的操作（P4-S3 spec §3、§4）。role 是调用者在这个空间里的有效角色（已按归档降级）。
 * 看得到空间内容的人都看得到回收站的列表（标题在删除之前他本来就看得到），能不能动它由这里决定。
 */
export function trashPermissionsOf(role: SpaceRole, deletedBy: string, userId: string): TrashPermissions {
  // 恢复是把内容放回空间里，属于改动，所以先要有编辑者及以上的有效角色，再看是不是删除者本人或空间管理员（spec §3）。
  // 归档的空间里有效角色至多是查看者，这一条因此自然不成立；删完之后被降为查看者的人同样不能再恢复
  return {
    canRestore: atLeast(role, 'editor') && (deletedBy === userId || role === 'admin'),
    // 与 spacePermissionsOf 的 canPurgeTrash 同一条规则：空间管理员 / 个人空间的所有者
    canPurge: role === 'admin',
  }
}
