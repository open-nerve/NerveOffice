// 有效权限的规则（00 号计划书 §5.2、§5.3，M2-P2 设计 §3.4）：只按事实计算，不查询。
// 访问策略（document-access-policy.ts）取事实、调用这里；服务不自己拼权限条件（M2 总设计 §6.1）。
import type { DocumentPermissions, FolderPermissions, SpacePermissions, SpaceRole, TrashPermissions } from '@nerve-office/contracts'
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

/**
 * 一个人在一个空间里的有效角色；没有任何角色时为 undefined。
 * - 个人空间：所有者是空间管理员，其他人（包括系统管理员）都没有角色；个人空间的成员行一概不计。
 * - 团队空间：成员的角色；全员可见时，任何有效账户至少是查看者；归档时所有人至多是查看者。
 */
export function effectiveSpaceRole(space: SpaceFacts): SpaceRole | undefined {
  if (space.type === 'personal')
    return space.owned ? 'admin' : undefined
  // 查看者是最低的角色：成员的角色与"全员可见的查看者"取较高者，就是有成员角色时取成员角色
  const role = space.memberRole ?? (space.visibleToAll ? 'viewer' : undefined)
  if (role === undefined)
    return undefined
  return space.status === 'archived' ? 'viewer' : role
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
 * 在一份文档上能做的操作（00 号计划书 §5.3，M2-P4 设计 §3.7）。role 是调用者对这份文档的有效角色（已按归档降级），
 * 由访问策略给出；能拿到角色就说明看得到这份文档（P5 的单独授权也在策略里并进这个角色）。
 */
export function documentPermissionsOf(role: SpaceRole, document: DocumentOwnership, userId: string): DocumentPermissions {
  const editor = atLeast(role, 'editor')
  return {
    canEdit: editor,
    canRename: editor,
    canMoveWithinSpace: editor,
    // 跨空间移动要源空间的空间管理员（目标空间的新建权限另判）；归档的空间里有效角色至多是查看者
    canMoveAcrossSpaces: role === 'admin',
    // 能读就能复制（目标空间的新建权限另判）：查看者、归档空间里的成员也可以
    canCopy: true,
    // 删除（进回收站）：空间管理员任意，编辑者只能删自己创建的（P4-S3 spec §2）
    canDelete: role === 'admin' || (editor && document.createdBy === userId),
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
export function trashPermissionsOf(space: SpaceFacts, role: SpaceRole, deletedBy: string, userId: string): TrashPermissions {
  // 归档的空间只能查看：有效角色已降为查看者，所以"空间管理员"这一支自然不成立；
  // "删除者本人"与角色无关，所以这里要显式排除归档（spec §3）
  const archived = space.status === 'archived'
  return {
    canRestore: !archived && (deletedBy === userId || role === 'admin'),
    // 与 spacePermissionsOf 的 canPurgeTrash 同一条规则：空间管理员 / 个人空间的所有者
    canPurge: role === 'admin',
  }
}
