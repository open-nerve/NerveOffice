// 编辑器身份（P4 设计 §3.6.9，ADR-009；M2-P3 设计 §3.2 是它的延伸）：用按文档权限回答的实现替换 SDK 的本地授权服务，不调用 setCurrentUser。
// - 平台在创建编辑器时给出这份文档这次能不能编辑（EditorAccess：编辑器页按服务端的 permissions.canEdit 决定），授权服务按它回答。
//   写入的边界仍在服务端（查看者的保存一律被拒，ADR-011），这里决定的只是编辑器里的权限点；
// - SDK 在 Ready 与用户变化时用 allowed() 的结果设置工作簿的 22 个权限点（sheets 的 sheet-permission-init.controller.ts:171-191、333-385），
//   有保护规则的工作表与区域按 batchAllowed() 的结果设置（同一文件 :66-121、:263-331）。它只认明确的布尔值，所以每个动作都给出 true 或 false：
//   - edit：每个动作都允许。返回不允许会锁死编辑（M0 看到的"真实用户身份锁死编辑"就是这个机制）；
//   - read：只允许"查看"与"复制"，其余一律不允许。查看是打开的前提；复制是"可以选中与复制内容"（US-M2-11），
//     它要求工作簿与工作表的复制权限点都为真（M0-P3 审查 R6）。其余动作都会改动文档或权限（编辑、增删改工作表、排序、筛选、插入超链接……），
//     或者本平台没有（打印、导出、历史记录）。只读的文档设出来就是只读的，用户变化时也不会被改回可编辑（M1 独立复验 N1 的根因）；
// - 本地授权服务不再构造，它在构造时注册的资源 SHEET_AuthzIoMockService_PLUGIN 随之消失，当前用户保持匿名（userID 为空）；
// - 权限数据的写入（保护规则、协作者）一律拒绝：界面入口已经隐藏，SDK 不管理本平台的权限，快照里也就不会出现保护规则
import type { DependencyOverride } from '@univerjs/core'
import type { EditorAccess } from '../editor-access.ts'
import { IAuthzIoService, WorkbookCopyPermission, WorkbookViewPermission } from '../internal-api/index.ts'

type AllowedRequest = Parameters<IAuthzIoService['allowed']>[0]
type Action = AllowedRequest['actions'][number]
type ActionInfo = Awaited<ReturnType<IAuthzIoService['allowed']>>[number]
type ObjectActions = Awaited<ReturnType<IAuthzIoService['batchAllowed']>>
type PermissionPoints = Awaited<ReturnType<IAuthzIoService['list']>>
type Roles = Awaited<ReturnType<IAuthzIoService['listRoles']>>
type Collaborators = Awaited<ReturnType<IAuthzIoService['listCollaborators']>>

/** 权限数据的写入被拒绝：本平台的权限不经 Univer 管理 */
export class AuthzWriteRejectedError extends Error {
  constructor(method: string) {
    super(`编辑器不管理权限数据（ADR-009），拒绝 IAuthzIoService.${method}`)
    this.name = 'AuthzWriteRejectedError'
  }
}

/** 权限点的动作与单元无关：构造权限点只为取它的 subType（类的字段，要有实例才取得到） */
const ANY_UNIT = ''

/**
 * 只读时允许的动作：查看与复制。取自 SDK 的工作簿权限点，与只读守卫保留的工作表权限点（WorksheetViewPermission、
 * WorksheetCopyPermission）是同一组定义；不为动作的枚举（@univerjs/protocol 的 UnitAction）新增依赖
 */
function readOnlyActions(): ReadonlySet<Action> {
  return new Set([new WorkbookViewPermission(ANY_UNIT).subType, new WorkbookCopyPermission(ANY_UNIT).subType])
}

export class EditorAuthzIoService implements IAuthzIoService {
  private readonly allows: (action: Action) => boolean

  constructor(access: EditorAccess) {
    if (access === 'edit') {
      this.allows = () => true
    }
    else {
      const allowed = readOnlyActions()
      this.allows = action => allowed.has(action)
    }
  }

  /** 请求的每个动作按顺序给出明确的布尔值 */
  private answer(request: AllowedRequest): ActionInfo[] {
    return request.actions.map(action => ({ action, allowed: this.allows(action) }))
  }

  async allowed(request: AllowedRequest): Promise<ActionInfo[]> {
    return this.answer(request)
  }

  /** 形状与本地实现相同：按请求的顺序，每个对象一项（core 的 authz-io-local.service.ts:187-195） */
  async batchAllowed(requests: AllowedRequest[]): Promise<ObjectActions> {
    return requests.map(request => ({ unitID: request.unitID, objectID: request.objectID, actions: this.answer(request) }))
  }

  async list(): Promise<PermissionPoints> {
    return []
  }

  async listRoles(): Promise<Roles> {
    return { roles: [], actions: [] }
  }

  async listCollaborators(): Promise<Collaborators> {
    return []
  }

  async create(): Promise<string> {
    throw new AuthzWriteRejectedError('create')
  }

  async update(): Promise<void> {
    throw new AuthzWriteRejectedError('update')
  }

  async updateCollaborator(): Promise<void> {
    throw new AuthzWriteRejectedError('updateCollaborator')
  }

  async deleteCollaborator(): Promise<void> {
    throw new AuthzWriteRejectedError('deleteCollaborator')
  }

  async createCollaborator(): Promise<void> {
    throw new AuthzWriteRejectedError('createCollaborator')
  }

  async putCollaborators(): Promise<void> {
    throw new AuthzWriteRejectedError('putCollaborators')
  }
}

/**
 * 交给 new Univer({ override })：核心注入器里的 IAuthzIoService 换成按 access 回答的实例（core 的 univer.ts:295、plugin-override.ts:28-43）。
 * 用 useValue 交出构造好的实例：access 是这次创建时给定的，SDK 的注入器不认识它
 */
export function editorIdentityOverride(access: EditorAccess): DependencyOverride {
  return [[IAuthzIoService, { useValue: new EditorAuthzIoService(access) }]]
}
