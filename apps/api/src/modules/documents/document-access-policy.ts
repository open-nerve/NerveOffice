import type { SpacePermissions, SpaceRole } from '@nerve-office/contracts'
import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { SpaceFacts } from '../spaces/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { SpacesService } from '../spaces/index.ts'
import { atLeast, effectiveSpaceRole, spacePermissionsOf } from './access-rules.ts'

/** 调用者（M2-P2 设计 §3.4）：系统角色只影响团队空间的管理操作，不带来任何内容权限（00 号计划书 §5.2）。 */
export interface Actor {
  readonly userId: string
  readonly systemAdmin: boolean
}

/** 当前登录的人作为调用者：系统角色来自会话守卫，每个请求重新读取。 */
export function accessActorOf(principal: Principal): Actor {
  return { userId: principal.user.id, systemAdmin: principal.user.systemRole === 'admin' }
}

/** 判断文档权限要用到的文档属性：所在的空间（P5 的单独授权另按文档 id）。 */
export interface AccessTarget {
  readonly id: string
  readonly spaceId: string
}

/** 调用者对一份文档的有效角色，与文档所在的空间。 */
export interface DocumentAccess {
  readonly role: SpaceRole
  readonly space: SpaceFacts
}

/**
 * 调用者对一个空间的访问：有效角色与能做的操作。
 * role 为 undefined 表示没有内容权限：只有没有加入的系统管理员对团队空间会这样，他只能做空间的管理操作。
 */
export interface SpaceAccess {
  readonly space: SpaceFacts
  readonly role: SpaceRole | undefined
  readonly permissions: SpacePermissions
}

/** 有内容权限的空间访问：看空间的内容、在里面新建。 */
export interface SpaceContentAccess extends SpaceAccess {
  readonly role: SpaceRole
}

/**
 * 访问策略：有效权限的唯一入口（M2 总设计 §6.1，M2-P2 设计 §3.4），目标是文档或空间。
 * 服务只经它判断权限，不自己拼权限条件；在事务里判断时传入事务，查询走事务的连接，不再从连接池另取一个。
 */
export abstract class DocumentAccessPolicy {
  /** 文档：有效角色与所在的空间；没有任何权限时为 undefined，调用方按"不存在"处理，不暴露文档是否存在 */
  abstract accessOf(userId: string, document: AccessTarget, transaction?: Transaction): Promise<DocumentAccess | undefined>

  /** 空间：看不到时为 undefined（不存在与看不到执行同样的查询） */
  abstract spaceAccessOf(actor: Actor, spaceId: string, transaction?: Transaction): Promise<SpaceAccess | undefined>

  /** 我能看到的空间（有内容权限的）：导航与"可访问文档"。个人空间在前，团队空间按名称排序 */
  abstract visibleSpaces(actor: Actor): Promise<SpaceContentAccess[]>
}

/**
 * 有效权限（M2-P2）：空间的部分按 spaces 的空间事实计算（access-rules.ts）；P5 在这里并上单独授权。
 * 每个判断只执行一条空间事实的查询，空间或文档不存在时也一样。
 */
@Injectable()
export class EffectiveAccessPolicy extends DocumentAccessPolicy {
  constructor(private readonly spaces: SpacesService) {
    super()
  }

  async accessOf(userId: string, document: AccessTarget, transaction?: Transaction): Promise<DocumentAccess | undefined> {
    const space = await this.spaces.accessFactsOf(userId, document.spaceId, { transaction })
    const role = space === undefined ? undefined : effectiveSpaceRole(space)
    return space === undefined || role === undefined ? undefined : { role, space }
  }

  async spaceAccessOf(actor: Actor, spaceId: string, transaction?: Transaction): Promise<SpaceAccess | undefined> {
    const space = await this.spaces.accessFactsOf(actor.userId, spaceId, { transaction })
    if (space === undefined)
      return undefined
    const role = effectiveSpaceRole(space)
    // 没有空间角色的人看不到这个空间；只有系统管理员看得到团队空间的管理面（成员、改名），个人空间对他始终看不到
    if (role === undefined && !(actor.systemAdmin && space.type === 'team'))
      return undefined
    return { space, role, permissions: spacePermissionsOf(space, role, actor.systemAdmin) }
  }

  async visibleSpaces(actor: Actor): Promise<SpaceContentAccess[]> {
    const candidates = await this.spaces.visibleSpacesOf(actor.userId)
    return candidates.flatMap((space) => {
      const role = effectiveSpaceRole(space)
      return role === undefined ? [] : [{ space, role, permissions: spacePermissionsOf(space, role, actor.systemAdmin) }]
    })
  }
}

/** 不存在的对象也照样判断一次权限：用一个不存在的空间。两条路径做同样的查询，响应时间不暴露对象是否存在（M1-P3 审查 A4）。 */
const MISSING_ID = '00000000-0000-0000-0000-000000000000'
const MISSING_DOCUMENT: AccessTarget = { id: MISSING_ID, spaceId: MISSING_ID }

/** 能访问的文档与调用者的权限。 */
export interface Accessible<T extends AccessTarget> {
  readonly document: T
  readonly access: DocumentAccess
}

/**
 * 读取或编辑一份文档之前的权限判断：没有任何权限与不存在都是同一个 NOT_FOUND（规范 §4，US-M1-08）。
 * 文档不存在时也判断一次权限（见 MISSING_DOCUMENT）。
 */
export async function requireAccess<T extends AccessTarget>(
  policy: DocumentAccessPolicy,
  userId: string,
  document: T | undefined,
  transaction?: Transaction,
): Promise<Accessible<T>> {
  const access = await policy.accessOf(userId, document ?? MISSING_DOCUMENT, transaction)
  if (document === undefined || access === undefined)
    throw new AppError('NOT_FOUND')
  return { document, access }
}

/** 能不能改动文档的内容与元数据：编辑者及以上（归档的空间里所有人至多是查看者）。 */
export function canEdit(access: DocumentAccess): boolean {
  return atLeast(access.role, 'editor')
}

/** 看得到却不能做时的说明：归档的空间另外说明原因。 */
function denied(access: SpaceAccess, message: string): AppError {
  return new AppError('PERMISSION_DENIED', access.space.status === 'archived' ? '空间已归档，只能查看' : message)
}

/**
 * 看空间的内容（按空间列出、空间页）或在里面新建之前的判断：要有空间角色，否则是 NOT_FOUND
 * （没有加入的系统管理员也一样：系统角色不带来内容权限）；能看却不能新建是 PERMISSION_DENIED（ADR-006）。
 */
export async function requireSpaceContent(
  policy: DocumentAccessPolicy,
  actor: Actor,
  spaceId: string,
  operation: 'view' | 'createDocuments',
  transaction?: Transaction,
): Promise<SpaceContentAccess> {
  const access = await policy.spaceAccessOf(actor, spaceId, transaction)
  if (access?.role === undefined)
    throw new AppError('NOT_FOUND')
  if (operation === 'createDocuments' && !access.permissions.canCreateDocuments)
    throw denied(access, '没有在这个空间里新建的权限')
  return { ...access, role: access.role }
}

/** 空间的管理操作与各自的权限。 */
const MANAGEMENT: Readonly<Record<'viewMembers' | 'manageMembers' | 'rename', { readonly permission: keyof SpacePermissions, readonly message: string }>> = {
  viewMembers: { permission: 'canViewMembers', message: '个人空间没有成员' },
  manageMembers: { permission: 'canManageMembers', message: '只有空间管理员能管理成员' },
  rename: { permission: 'canRename', message: '只有空间管理员能改名，个人空间不能改名' },
}

/**
 * 空间的管理操作（查看与管理成员、改名）之前的判断：看不到是 NOT_FOUND；
 * 看得到（有空间角色，或者是系统管理员而目标是团队空间）却没有这个权限是 PERMISSION_DENIED。
 */
export async function requireSpaceManagement(
  policy: DocumentAccessPolicy,
  actor: Actor,
  spaceId: string,
  operation: 'viewMembers' | 'manageMembers' | 'rename',
  transaction?: Transaction,
): Promise<SpaceAccess> {
  const access = await policy.spaceAccessOf(actor, spaceId, transaction)
  if (access === undefined)
    throw new AppError('NOT_FOUND')
  const { permission, message } = MANAGEMENT[operation]
  if (!access.permissions[permission])
    throw denied(access, message)
  return access
}
