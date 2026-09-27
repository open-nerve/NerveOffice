// 编辑器身份（P4 设计 §3.6.9，ADR-009）：用"全部允许"的实现替换 SDK 的本地授权服务，不调用 setCurrentUser。
// - 读写的边界在服务端：能打开编辑器的人就能编辑这份文档（M1 没有阅读模式与租约）；
// - 每次打开工作簿，SDK 都用 allowed() 的结果设置工作簿的权限点（sheets 的 sheet-permission-init.controller.ts:171-191），
//   所以每个动作都返回允许；返回不允许会锁死编辑（M0 看到的"真实用户身份锁死编辑"就是这个机制）；
// - 本地授权服务不再构造，它在构造时注册的资源 SHEET_AuthzIoMockService_PLUGIN 随之消失，当前用户保持匿名（userID 为空）；
// - 权限数据的写入（保护规则、协作者）一律拒绝：界面入口已经隐藏，SDK 不管理本平台的权限，快照里也就不会出现保护规则
import type { DependencyOverride } from '@univerjs/core'
import { IAuthzIoService } from '../internal-api/index.ts'

type AllowedRequest = Parameters<IAuthzIoService['allowed']>[0]
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

function allowEvery(request: AllowedRequest): ActionInfo[] {
  return request.actions.map(action => ({ action, allowed: true }))
}

export class AllowAllAuthzIoService implements IAuthzIoService {
  async allowed(request: AllowedRequest): Promise<ActionInfo[]> {
    return allowEvery(request)
  }

  /** 形状与本地实现相同：按请求的顺序，每个对象一项（core 的 authz-io-local.service.ts:187-195） */
  async batchAllowed(requests: AllowedRequest[]): Promise<ObjectActions> {
    return requests.map(request => ({ unitID: request.unitID, objectID: request.objectID, actions: allowEvery(request) }))
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

/** 交给 new Univer({ override })：核心注入器里的 IAuthzIoService 换成这个实现（core 的 univer.ts:295、plugin-override.ts:28-43） */
export function editorIdentityOverride(): DependencyOverride {
  return [[IAuthzIoService, { useClass: AllowAllAuthzIoService }]]
}
