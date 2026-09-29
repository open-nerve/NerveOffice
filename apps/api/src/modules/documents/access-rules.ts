// 有效权限的规则（00 号计划书 §5.2、§5.3，M2-P2 设计 §3.4）：只按事实计算，不查询。
// 访问策略（document-access-policy.ts）取事实、调用这里；服务不自己拼权限条件（M2 总设计 §6.1）。
import type { FolderPermissions, SpacePermissions, SpaceRole } from '@nerve-office/contracts'
import type { SpaceFacts } from '../spaces/index.ts'
import { SPACE_ROLES } from '@nerve-office/contracts'

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
 * 在一个文件夹上能做的操作（M2-P4 设计 §3.7）。v0.1 的权限只到空间与文档两级，文件夹没有自己的权限，
 * 所以只看调用者在这个空间里的有效角色（已按归档降级）。
 * 只给本 Step 提供的操作：跨空间移动与删除随 S2、S3 加上各自的位（删除另有"里面只有本人创建的文档"，在锁下用计数语句判断）。
 */
export function folderPermissionsOf(role: SpaceRole | undefined): FolderPermissions {
  const editor = role !== undefined && atLeast(role, 'editor')
  return { canRename: editor, canMoveWithinSpace: editor }
}
