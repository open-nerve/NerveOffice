import { describe, expect, it } from 'vitest'
import { IAuthzIoService } from '../internal-api/index.ts'
import { AllowAllAuthzIoService, AuthzWriteRejectedError, editorIdentityOverride } from './allow-all-authz-io.service.ts'

type AllowedRequest = Parameters<IAuthzIoService['allowed']>[0]

// UnitObject.Workbook = 1、SelectRange = 3；UnitAction 取几个常见的值（编辑、查看、复制、打印……）
const workbookRequest: AllowedRequest = { objectID: 'unit-1', objectType: 1, unitID: 'unit-1', actions: [2, 3, 5, 6, 16] }
const rangeRequest: AllowedRequest = { objectID: 'rule-1', objectType: 3, unitID: 'unit-1', actions: [2, 3] }

describe('全部允许的 IAuthzIoService（ADR-009）', () => {
  const service = new AllowAllAuthzIoService()

  it('allowed：请求的每个动作都允许，顺序不变', async () => {
    await expect(service.allowed(workbookRequest)).resolves.toEqual([2, 3, 5, 6, 16].map(action => ({ action, allowed: true })))
  })

  it('没有请求动作时返回空数组', async () => {
    await expect(service.allowed({ ...workbookRequest, actions: [] })).resolves.toEqual([])
  })

  it('batchAllowed：按请求的顺序，每个对象一项，形状与本地实现相同', async () => {
    await expect(service.batchAllowed([workbookRequest, rangeRequest])).resolves.toEqual([
      { unitID: 'unit-1', objectID: 'unit-1', actions: [2, 3, 5, 6, 16].map(action => ({ action, allowed: true })) },
      { unitID: 'unit-1', objectID: 'rule-1', actions: [2, 3].map(action => ({ action, allowed: true })) },
    ])
  })

  it('列表一类返回空', async () => {
    await expect(service.list()).resolves.toEqual([])
    await expect(service.listRoles()).resolves.toEqual({ roles: [], actions: [] })
    await expect(service.listCollaborators()).resolves.toEqual([])
  })

  it('权限数据的写入一律拒绝：保护规则与协作者都不经 Univer 管理', async () => {
    const writes = [
      ['create', service.create()],
      ['update', service.update()],
      ['updateCollaborator', service.updateCollaborator()],
      ['deleteCollaborator', service.deleteCollaborator()],
      ['createCollaborator', service.createCollaborator()],
      ['putCollaborators', service.putCollaborators()],
    ] as const
    for (const [method, write] of writes) {
      const error: unknown = await write.catch((reason: unknown) => reason)
      expect(error, method).toBeInstanceOf(AuthzWriteRejectedError)
      expect((error as Error).message, method).toContain(method)
    }
  })
})

describe('依赖覆盖', () => {
  it('把核心注入器里的 IAuthzIoService 换成全部允许的实现', () => {
    expect(editorIdentityOverride()).toEqual([[IAuthzIoService, { useClass: AllowAllAuthzIoService }]])
  })
})
