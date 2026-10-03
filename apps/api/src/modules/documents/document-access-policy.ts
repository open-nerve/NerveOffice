import type { DocumentPermissions, FolderPermissions, GrantRole, SpacePermissions, SpaceRole, TrashPermissions } from '@nerve-office/contracts'
import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { SpaceFacts } from '../spaces/index.ts'
import type { DocumentAccess, DocumentOwnership } from './access-rules.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { SpacesService } from '../spaces/index.ts'
import { canShareOnceRestored, documentAccessOf, documentPermissionsOf, effectiveSpaceRole, folderPermissionsOf, spacePermissionsOf, trashPermissionsOf } from './access-rules.ts'
import { DocumentGrantsRepository } from './document-grants.repository.ts'

/** 调用者（M2-P2 设计 §3.4）：系统角色只影响团队空间的管理操作，不带来任何内容权限（00 号计划书 §5.2）。 */
export interface Actor {
  readonly userId: string
  readonly systemAdmin: boolean
}

/** 当前登录的人作为调用者：系统角色来自会话守卫，每个请求重新读取。 */
export function accessActorOf(principal: Principal): Actor {
  return { userId: principal.user.id, systemAdmin: principal.user.systemRole === 'admin' }
}

/**
 * 判断文档权限要用到的文档属性：所在的空间、文档的 id（单独授权按它找）、创建人（删除的权限按它判断）。
 */
export interface AccessTarget extends DocumentOwnership {
  readonly id: string
  readonly spaceId: string
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

/** 批量判断的一份文档：判断它的属性，与这个人在它上面的单独授权（由调用方从列出它的那一条语句里带来，见 accessOfMany） */
export interface GrantedTarget {
  readonly document: AccessTarget
  readonly grant: GrantRole | undefined
}

/** 批量判断的结果：调用者对这份文档的访问，与所在空间的所有者（个人空间按所有者的人名呈现；团队空间为空） */
export interface LocatedAccess {
  readonly access: DocumentAccess
  readonly ownerUserId: string | null
}

/**
 * 访问策略：有效权限的唯一入口（M2 总设计 §6.1，M2-P2 设计 §3.4），目标是文档或空间。
 * 服务只经它判断权限，不自己拼权限条件；在事务里判断时传入事务，查询走事务的连接，不再从连接池另取一个。
 */
export abstract class DocumentAccessPolicy {
  /**
   * 文档：空间角色、内容权限、访问途径与所在的空间（access-rules 的 DocumentAccess）；空间角色与单独授权都没有时为 undefined，
   * 调用方按"不存在"处理，不暴露文档是否存在
   */
  abstract accessOf(userId: string, document: AccessTarget, transaction?: Transaction): Promise<DocumentAccess | undefined>

  /** 空间：看不到时为 undefined（不存在与看不到执行同样的查询）。不看单独授权：授权不给空间里的任何东西开口子（M2-P5 设计 §3.4(1)） */
  abstract spaceAccessOf(actor: Actor, spaceId: string, transaction?: Transaction): Promise<SpaceAccess | undefined>

  /** 我能看到的空间（有内容权限的）：导航与"可访问文档"。个人空间在前，团队空间按名称排序。在读请求的只读快照里调用（M2 Codex 评审 CX1） */
  abstract visibleSpaces(actor: Actor, transaction: Transaction): Promise<SpaceContentAccess[]>

  /**
   * 一批文档上的访问（M2-P5 设计 §3.4(4)，"与我共享"）：空间事实按一批 id 取（一条语句），规则仍是 documentAccessOf——
   * 服务不另算。单独授权由调用方从列出这批文档的那一条语句里带来（"与我共享"的条件就是授权那一半，角色与行出自同一个快照；
   * 再另读一次，两次读之间并发的取消分享会让同一页的结果自相矛盾）。按文档 id 给出；看不到的（空间不存在、两样都没有）不在结果里。
   * 在读请求的只读快照里调用：空间事实与列出这批文档的语句出自同一个快照（M2 Codex 评审 CX1）
   */
  abstract accessOfMany(userId: string, documents: readonly GrantedTarget[], transaction: Transaction): Promise<ReadonlyMap<string, LocatedAccess>>
}

/**
 * 有效权限（M2-P2，M2-P5 并上单独授权）：空间的部分按 spaces 的空间事实计算，文档另并上这个人在它上面的单独授权（access-rules.ts）。
 * 对空间的判断只执行一条空间事实的查询；对文档的判断执行两条（空间事实、授权），空间或文档不存在时也一样。
 */
@Injectable()
export class EffectiveAccessPolicy extends DocumentAccessPolicy {
  constructor(
    private readonly spaces: SpacesService,
    private readonly grants: DocumentGrantsRepository,
  ) {
    super()
  }

  /**
   * 两条语句，总是都执行（M2-P5 设计 §3.1）：空间事实在 spaces、授权在 documents 的仓储，按模块边界不能联成一条（ADR-014 否决跨模块联表）。
   * 不存在的文档（MISSING_DOCUMENT，全零的 id）同样执行这两条：看不到与不存在的语句序列相同（permissions/hidden-missing-parity 核对）。
   * 所以不能写成"空间不存在就提前返回"——那样不存在的文档少执行授权那一条。逐条执行（不并发）：语句的先后是确定的，
   * 在事务里也只有一个连接
   */
  async accessOf(userId: string, document: AccessTarget, transaction?: Transaction): Promise<DocumentAccess | undefined> {
    const space = await this.spaces.accessFactsOf(userId, document.spaceId, { transaction })
    const grant = await this.grants.roleOf(document.id, userId, transaction)
    return space === undefined ? undefined : documentAccessOf(space, grant)
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

  async visibleSpaces(actor: Actor, transaction: Transaction): Promise<SpaceContentAccess[]> {
    const candidates = await this.spaces.visibleSpacesOf(actor.userId, { transaction })
    return candidates.flatMap((space) => {
      const role = effectiveSpaceRole(space)
      return role === undefined ? [] : [{ space, role, permissions: spacePermissionsOf(space, role, actor.systemAdmin) }]
    })
  }

  async accessOfMany(userId: string, documents: readonly GrantedTarget[], transaction: Transaction): Promise<ReadonlyMap<string, LocatedAccess>> {
    if (documents.length === 0)
      return new Map()
    const facts = await this.spaces.accessFactsOfMany(userId, documents.map(({ document }) => document.spaceId), { transaction })
    return new Map(documents.flatMap(({ document, grant }) => {
      const space = facts.get(document.spaceId)
      const access = space === undefined ? undefined : documentAccessOf(space, grant)
      return space === undefined || access === undefined ? [] : [[document.id, { access, ownerUserId: space.ownerUserId }] as const]
    }))
  }
}

/** 不存在的对象也照样判断一次权限：用一个不存在的空间。两条路径做同样的查询，响应时间不暴露对象是否存在（M1-P3 审查 A4）。 */
const MISSING_ID = '00000000-0000-0000-0000-000000000000'
const MISSING_DOCUMENT: AccessTarget = { id: MISSING_ID, spaceId: MISSING_ID, createdBy: MISSING_ID }

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

/**
 * 这个人现在能不能编辑这份文档：访问策略给出的权限里有 canEdit（access-rules 的权限位，与保存、申请编辑权看的是同一位）。
 * 编辑租约用它判断持有者（有效条件第 7 条、收回写入权，M3-P1 设计 §3.4.1、§3.4.6）。只看权限：文档是不是还在正常状态，
 * 由调用方按它读到的那一行判断
 */
export async function canEditDocument(policy: DocumentAccessPolicy, userId: string, document: AccessTarget, transaction: Transaction): Promise<boolean> {
  const access = await policy.accessOf(userId, document, transaction)
  return access !== undefined && documentPermissionsOf(access, document, userId).canEdit
}

/** 归档的空间里"不能做"的默认说明：归档时所有人至多是查看者 */
const ARCHIVED_MESSAGE = '空间已归档，只能查看'

/**
 * 归档的空间里分享冻结（需求方 2026-10-01 确认，M2-P5 设计 §3.2）：授权列表的查看、设置、调整、取消都不能做，要先由系统管理员恢复空间。
 * 与默认的"只能查看"不同：已有的授权照常生效（一律降为查看者），只是不能再改。这句话许诺了恢复之后能调整，只给恢复之后能分享的人
 * （归档之前是空间管理员的人、个人空间的所有者，access-rules 的 canShareOnceRestored；M2-P5 审查 A 的一般 6、B 的 G1）
 */
export const SHARING_FROZEN_MESSAGE = '空间已归档，恢复之后才能调整分享'

/** 空间、文件夹、回收站上看得到却不能做时的说明：归档的空间另外说明原因（文档上的操作见 documentDeniedMessage）。 */
function denied(space: SpaceFacts, message: string): AppError {
  return new AppError('PERMISSION_DENIED', space.status === 'archived' ? ARCHIVED_MESSAGE : message)
}

/** 能访问的文档、调用者在它上面的权限与所在空间的访问。 */
export interface AccessibleDocument<T extends AccessTarget> extends Accessible<T> {
  readonly permissions: DocumentPermissions
}

/** 文档上要权限的操作（只看能不能读时用 requireAccess）；edit 是保存内容，share 是查看与改动这份文档的单独授权（M2-P5）。 */
export type DocumentOperation = 'edit' | 'rename' | 'moveWithinSpace' | 'moveAcrossSpaces' | 'copy' | 'delete' | 'share'

/** 一项操作看的权限位与不能做时的说明 */
interface DocumentOperationRule {
  readonly permission: keyof DocumentPermissions
  /**
   * 看得到却不能做时的说明（空间没归档时；归档时见 frozen）。可以按空间角色区分：删除时空间角色是编辑者的人只是不能删别人创建的，
   * 不是编辑者的人根本不能删（M2-P5 S4 主会话的决定）
   */
  readonly message: string | ((spaceRole: SpaceRole | undefined) => string)
  /**
   * 结构性的操作（只看空间角色的权限位）：只凭授权的人一律不能做（M2-P5 设计 §3.4(1)），另给这一句说明——
   * 原来的说明对他不成立（例如"编辑者只能删除自己创建的文档"：他可能正是创建人，只是已经不在那个空间里）
   */
  readonly grantOnlyMessage?: string
  /**
   * 归档的空间里另有的说法与它给谁（分享：冻结的说明）。这句话许诺了恢复之后能做，只给恢复之后确实能做的人（onceRestored，
   * 按归档之前的空间角色；M2-P5 审查 A 的一般 6、B 的 G1），其余的人给不归档时的说明。
   * 没有它的操作在归档的空间里一律是默认的"空间已归档，只能查看"：归档时所有人至多是查看者，这句对谁都成立
   */
  readonly frozen?: { readonly message: string, readonly onceRestored: (space: SpaceFacts) => boolean }
}

/** 删除被拒：空间角色是编辑者的人删的是别人创建的文档；别的人（查看者、全员可见给的查看者）根本不能删（M2-P5 S4 主会话的决定） */
function deleteDenied(spaceRole: SpaceRole | undefined): string {
  return spaceRole === 'editor' ? '编辑者只能删除自己创建的文档' : '没有删除这份文档的权限'
}

const DOCUMENT_CONTENT: Readonly<Record<DocumentOperation, DocumentOperationRule>> = {
  // 内容的操作：权限位看内容权限（空间角色与授权取较高者）。
  // 保存与其他操作同一套说明：归档的空间里说"空间已归档"，而不是"只能查看"（M2-P6 复核 A 的 G3）。
  // edit 由保存与申请编辑权共用（M3-P1），所以说"不能编辑"而不是"不能保存"
  edit: { permission: 'canEdit', message: '只能查看这份文档，不能编辑' },
  rename: { permission: 'canRename', message: '没有给这份文档改名的权限' },
  copy: { permission: 'canCopy', message: '没有复制这份文档的权限' },
  // 结构性的操作：权限位只看空间角色
  moveWithinSpace: { permission: 'canMoveWithinSpace', message: '没有移动这份文档的权限', grantOnlyMessage: '这份文档是单独分享给你的，不能移动' },
  moveAcrossSpaces: { permission: 'canMoveAcrossSpaces', message: '只有空间管理员能把文档移出这个空间', grantOnlyMessage: '这份文档是单独分享给你的，不能移动' },
  delete: { permission: 'canDelete', message: deleteDenied, grantOnlyMessage: '这份文档是单独分享给你的，不能删除' },
  // 分享（M2-P5 设计 §3.2）：结构性的操作，只看空间角色——空间管理员或个人空间的所有者；归档的空间里冻结，
  // 冻结的说明只给恢复之后能分享的人，空间里的编辑者、查看者照旧是"只有空间管理员能分享"
  share: {
    permission: 'canShare',
    message: '只有空间管理员能分享这份文档',
    grantOnlyMessage: '这份文档是单独分享给你的，不能再分享给别人',
    frozen: { message: SHARING_FROZEN_MESSAGE, onceRestored: canShareOnceRestored },
  },
}

/**
 * 看得到这份文档、却不能做这项操作时的说明（只凭授权的人做结构性的操作另有一句，见 requireDocumentOperations）：
 * 空间没归档时是这一项通常的说法；归档时有 frozen 的操作给恢复之后能做的人那一句、其余的人通常的说法，没有的给默认的"只能查看"
 */
function documentDeniedMessage(rule: DocumentOperationRule, access: DocumentAccess): string {
  if (access.space.status === 'archived') {
    if (rule.frozen === undefined)
      return ARCHIVED_MESSAGE
    if (rule.frozen.onceRestored(access.space))
      return rule.frozen.message
  }
  return typeof rule.message === 'string' ? rule.message : rule.message(access.spaceRole)
}

/**
 * 整理一份文档（改名、移动、复制）之前的判断（M2-P4 设计 §3.7）：没有任何权限与不存在都是同一个 NOT_FOUND，
 * 看得到却不能做是 PERMISSION_DENIED。operations 是这次要做的操作，一次判断可以要求多项（例如既改名又移动）。
 */
export async function requireDocumentContent<T extends AccessTarget>(
  policy: DocumentAccessPolicy,
  userId: string,
  document: T | undefined,
  operations: readonly DocumentOperation[],
  transaction?: Transaction,
): Promise<AccessibleDocument<T>> {
  const accessible = await requireAccess(policy, userId, document, transaction)
  const checked = { ...accessible, permissions: documentPermissionsOf(accessible.access, accessible.document, userId) }
  requireDocumentOperations(checked, operations)
  return checked
}

/**
 * 已经判断过能访问（requireDocumentContent 的结果）之后，再要求这几项操作：不再查询，不能做是 PERMISSION_DENIED。
 * 保存先按"能访问"查重放、不是重放才要求能编辑时用它（00 号计划书 §7.4 第 2 步，M2-P6 复核 A 的 S-4）。
 * 权限位已经按内容与结构分开算好（access-rules 的 documentPermissionsOf）；只凭授权的人被结构性的操作拒绝时给他自己的说明，
 * 与空间归不归档无关（恢复之后他照样不能做）
 */
export function requireDocumentOperations(accessible: AccessibleDocument<AccessTarget>, operations: readonly DocumentOperation[]): void {
  for (const operation of operations) {
    const rule = DOCUMENT_CONTENT[operation]
    if (accessible.permissions[rule.permission])
      continue
    if (rule.grantOnlyMessage !== undefined && accessible.access.accessVia === 'grant')
      throw new AppError('PERMISSION_DENIED', rule.grantOnlyMessage)
    throw new AppError('PERMISSION_DENIED', documentDeniedMessage(rule, accessible.access))
  }
}

/**
 * 刚放进这个空间的一份文档上的访问（新建的、复制出来的副本、跨空间移进来的），用于在同一个事务里拼响应：按调用者在目标空间的
 * 访问算（access-rules 的 documentAccessOf，授权一项为空），服务不手工拼（M2-P5 设计 §3.4(1)）。
 * 新建与复制出来的文档没有任何授权（复制不带授权，§3.4(6)）；移进来的文档带着它原来的授权，但调用者在目标空间至少是编辑者
 * （要有新建的权限），授权最高只到编辑者，取较高者仍是空间角色——结果与并上授权相同
 */
export function documentAccessIn(target: SpaceContentAccess): DocumentAccess {
  const access = documentAccessOf(target.space, undefined)
  // SpaceContentAccess 的 role 就是按同一份事实算出的空间角色、不为空，这里一定有访问
  if (access === undefined)
    throw new Error(`有内容权限的空间里算不出文档的访问：${target.space.id}`)
  return access
}

/** 空间里的内容操作与各自的权限；'view' 只要有空间角色，没有额外的权限位。 */
export type SpaceContentOperation = 'view' | 'createDocuments' | 'createFolders'

/** 要在空间里新建什么：搬进来或复制进来的是文档还是文件夹（见 requireCreateTarget）。 */
export type CreateOperation = Exclude<SpaceContentOperation, 'view'>

const SPACE_CONTENT: Readonly<Record<CreateOperation, { readonly permission: keyof SpacePermissions, readonly message: string }>> = {
  createDocuments: { permission: 'canCreateDocuments', message: '没有在这个空间里新建的权限' },
  createFolders: { permission: 'canCreateFolders', message: '没有在这个空间里新建文件夹的权限' },
}

/**
 * 跨空间移动与复制的目标空间（M2-P4 设计 §3.2）：要看得到（否则 NOT_FOUND，不暴露空间是否存在）、
 * 没有归档（409 SPACE_ARCHIVED，与转移到已归档的团队空间一致）、有新建的权限（否则 PERMISSION_DENIED）。
 * 已归档排在没有权限之前：归档时所有人至多是查看者，说"没有权限"看不出真正的原因。
 *
 * create 说明这次要在目标空间里新建什么：搬文档、复制文档要 canCreateDocuments，搬文件夹要 canCreateFolders。
 * 今天两者是同一条规则（access-rules.ts），但它们是两个权限位，将来分开时这里不会悄悄按错的那一个判断（审查 A 建议 5）。
 */
export async function requireCreateTarget(
  policy: DocumentAccessPolicy,
  actor: Actor,
  spaceId: string,
  create: CreateOperation,
  transaction?: Transaction,
): Promise<SpaceContentAccess> {
  const access = await policy.spaceAccessOf(actor, spaceId, transaction)
  if (access?.role === undefined)
    throw new AppError('NOT_FOUND')
  if (access.space.status === 'archived')
    throw new AppError('SPACE_ARCHIVED')
  if (!access.permissions[SPACE_CONTENT[create].permission])
    throw denied(access.space, '没有在目标空间里新建的权限')
  return { ...access, role: access.role }
}

/**
 * 看空间的内容（按空间列出、空间页）或在里面新建之前的判断：要有空间角色，否则是 NOT_FOUND
 * （没有加入的系统管理员也一样：系统角色不带来内容权限）；能看却不能新建是 PERMISSION_DENIED（ADR-006）。
 */
export async function requireSpaceContent(
  policy: DocumentAccessPolicy,
  actor: Actor,
  spaceId: string,
  operation: SpaceContentOperation,
  transaction?: Transaction,
): Promise<SpaceContentAccess> {
  const access = await policy.spaceAccessOf(actor, spaceId, transaction)
  if (access?.role === undefined)
    throw new AppError('NOT_FOUND')
  const content = { ...access, role: access.role }
  requireSpaceOperation(content, operation)
  return content
}

/**
 * 已经判断过能看空间的内容之后，再要求在里面做这件事（新建）：不再查询，不能做是 PERMISSION_DENIED。
 * 只由 requireSpaceContent 用：新建文件夹原来先按"能看到"查重放、不是重放才单独要求能新建（M2-P6 复核 A 的 S-4），
 * 现在先查重放、不是重放直接要求能新建（M2 Codex 评审复验的一般 4），不再单独用它
 */
function requireSpaceOperation(access: SpaceContentAccess, operation: SpaceContentOperation): void {
  const required = operation === 'view' ? undefined : SPACE_CONTENT[operation]
  if (required !== undefined && !access.permissions[required.permission])
    throw denied(access.space, required.message)
}

/** 判断文件夹权限要用到的属性：所在的空间。v0.1 的权限只到空间与文档两级，文件夹没有自己的权限。 */
export interface FolderTarget {
  readonly id: string
  readonly spaceId: string
}

/** 能访问的文件夹与调用者在它上面的权限。 */
export interface AccessibleFolder<T extends FolderTarget> {
  readonly folder: T
  readonly space: SpaceContentAccess
  readonly permissions: FolderPermissions
}

/** 文件夹上要权限的操作（只看能不能看时传空数组）。 */
export type FolderOperation = 'rename' | 'moveWithinSpace' | 'moveAcrossSpaces' | 'delete'

const FOLDER_CONTENT: Readonly<Record<FolderOperation, { readonly permission: keyof FolderPermissions, readonly message: string }>> = {
  rename: { permission: 'canRename', message: '没有给这个文件夹改名的权限' },
  moveWithinSpace: { permission: 'canMoveWithinSpace', message: '没有移动这个文件夹的权限' },
  moveAcrossSpaces: { permission: 'canMoveAcrossSpaces', message: '只有空间管理员能把文件夹移出这个空间' },
  // "子树里正常状态的文档全部是本人创建的"另在锁下用计数语句判断（P4-S3 spec §2），不在这里
  delete: { permission: 'canDelete', message: '没有删除这个文件夹的权限' },
}

/**
 * 读取或改动一个文件夹之前的判断（M2-P4 设计 §3.5）：没有任何权限与不存在都是同一个 NOT_FOUND。
 * 文件夹不存在时也判断一次权限（用一个不存在的空间，见 MISSING_ID）：两条路径做同样的查询，不暴露文件夹是否存在。
 * operations 是这次要做的操作（一次改动可以既改名又移动，一条查询判断全部）；空数组表示只要能看这个空间的内容。
 */
export async function requireFolderContent<T extends FolderTarget>(
  policy: DocumentAccessPolicy,
  actor: Actor,
  folder: T | undefined,
  operations: readonly FolderOperation[],
  transaction?: Transaction,
): Promise<AccessibleFolder<T>> {
  const access = await policy.spaceAccessOf(actor, folder?.spaceId ?? MISSING_ID, transaction)
  if (folder === undefined || access?.role === undefined)
    throw new AppError('NOT_FOUND')
  const permissions = folderPermissionsOf(access.role)
  for (const operation of operations) {
    const { permission, message } = FOLDER_CONTENT[operation]
    if (!permissions[permission])
      throw denied(access.space, message)
  }
  return { folder, space: { ...access, role: access.role }, permissions }
}

/** 判断删除单元的权限要用到的属性：在哪个空间的回收站里、谁删的。 */
export interface TrashTarget {
  readonly spaceId: string
  readonly deletedBy: string
}

/** 能访问的删除单元、所在空间的访问与调用者在它上面的权限。 */
export interface AccessibleTrashEntry<T extends TrashTarget> {
  readonly entry: T
  readonly space: SpaceContentAccess
  readonly permissions: TrashPermissions
}

/** 删除单元上要权限的操作（只看能不能看时传空数组：看得到空间内容的人都看得到回收站的列表）。 */
export type TrashOperation = 'restore' | 'purge'

const TRASH: Readonly<Record<TrashOperation, { readonly permission: keyof TrashPermissions, readonly message: string }>> = {
  restore: { permission: 'canRestore', message: '只有删除的人或空间管理员能恢复' },
  purge: { permission: 'canPurge', message: '只有空间管理员能永久删除' },
}

/**
 * 读取或改动回收站里的一个删除单元之前的判断（P4-S3 spec §3、§4、§5）：
 * 看不到这个空间的内容与删除单元不存在都是同一个 NOT_FOUND（删除单元不存在时也判断一次权限，用一个不存在的空间）；
 * 看得到却不能做是 PERMISSION_DENIED，归档的空间另外说明原因。
 */
export async function requireTrashEntry<T extends TrashTarget>(
  policy: DocumentAccessPolicy,
  actor: Actor,
  entry: T | undefined,
  operations: readonly TrashOperation[],
  transaction?: Transaction,
): Promise<AccessibleTrashEntry<T>> {
  const access = await policy.spaceAccessOf(actor, entry?.spaceId ?? MISSING_ID, transaction)
  if (entry === undefined || access?.role === undefined)
    throw new AppError('NOT_FOUND')
  const permissions = trashPermissionsOf(access.role, entry.deletedBy, actor.userId)
  for (const operation of operations) {
    const { permission, message } = TRASH[operation]
    if (!permissions[permission])
      throw denied(access.space, message)
  }
  return { entry, space: { ...access, role: access.role }, permissions }
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
    throw denied(access.space, message)
  return access
}
