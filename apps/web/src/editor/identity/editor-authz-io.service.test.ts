import { describe, expect, it } from 'vitest'
import { IAuthzIoService, WorkbookCopyPermission, WorkbookViewPermission } from '../internal-api/index.ts'
import { AuthzWriteRejectedError, EditorAuthzIoService, editorIdentityOverride } from './editor-authz-io.service.ts'

type AllowedRequest = Parameters<IAuthzIoService['allowed']>[0]
type Action = AllowedRequest['actions'][number]

// 查看与复制取自 SDK 的工作簿权限点（与实现同一个来源）；其余动作按 @univerjs/protocol 的 UnitAction 写数值：
// 1 编辑、17 排序、18 筛选（全部取值见 protocol 的 permission.d.ts）
const VIEW = new WorkbookViewPermission('unit-1').subType
const COPY = new WorkbookCopyPermission('unit-1').subType
/** UnitAction 的全部取值（0–45，另有 -1 表示不认识的动作） */
const EVERY_ACTION = [-1, ...Array.from({ length: 46 }, (_, value) => value)] as Action[]

// UnitObject.Workbook = 1、Worksheet = 2、SelectRange = 3
const workbookRequest: AllowedRequest = { objectID: 'unit-1', objectType: 1, unitID: 'unit-1', actions: EVERY_ACTION }
const rangeRequest: AllowedRequest = { objectID: 'rule-1', objectType: 3, unitID: 'unit-1', actions: [1, VIEW] as Action[] }

function answers(actions: readonly Action[], allowed: (action: Action) => boolean): { action: Action, allowed: boolean }[] {
  return actions.map(action => ({ action, allowed: allowed(action) }))
}

describe('能编辑（access = edit）的 IAuthzIoService（ADR-009）', () => {
  const service = new EditorAuthzIoService('edit')

  it('allowed：请求的每个动作都允许，顺序不变', async () => {
    await expect(service.allowed(workbookRequest)).resolves.toEqual(answers(EVERY_ACTION, () => true))
  })

  it('没有请求动作时返回空数组', async () => {
    await expect(service.allowed({ ...workbookRequest, actions: [] })).resolves.toEqual([])
  })

  it('batchAllowed：按请求的顺序，每个对象一项，形状与本地实现相同', async () => {
    await expect(service.batchAllowed([workbookRequest, rangeRequest])).resolves.toEqual([
      { unitID: 'unit-1', objectID: 'unit-1', actions: answers(EVERY_ACTION, () => true) },
      { unitID: 'unit-1', objectID: 'rule-1', actions: answers([1, VIEW] as Action[], () => true) },
    ])
  })
})

describe('只读（access = read）的 IAuthzIoService（M2-P3 设计 §3.2）', () => {
  const service = new EditorAuthzIoService('read')

  it('查看与复制取自 SDK 的工作簿权限点：与 UnitAction 的查看（0）、复制（6）一致', () => {
    expect([VIEW, COPY]).toEqual([0, 6])
  })

  it('allowed：只允许查看与复制，其余动作一律不允许；每个动作都有明确的布尔值，顺序不变', async () => {
    const result = await service.allowed(workbookRequest)
    expect(result).toEqual(answers(EVERY_ACTION, action => action === VIEW || action === COPY))
    expect(result.every(item => typeof item.allowed === 'boolean')).toBe(true)
    expect(result.filter(item => item.allowed).map(item => item.action)).toEqual([VIEW, COPY])
  })

  it('不看对象的类型：工作表与区域的请求同样只允许查看与复制', async () => {
    await expect(service.allowed({ ...workbookRequest, objectType: 2, actions: [1, COPY, 17, 18] as Action[] }))
      .resolves
      .toEqual(answers([1, COPY, 17, 18] as Action[], action => action === COPY))
  })

  it('batchAllowed：按请求的顺序，每个对象一项，每项按同样的规则回答', async () => {
    await expect(service.batchAllowed([workbookRequest, rangeRequest])).resolves.toEqual([
      { unitID: 'unit-1', objectID: 'unit-1', actions: answers(EVERY_ACTION, action => action === VIEW || action === COPY) },
      { unitID: 'unit-1', objectID: 'rule-1', actions: [{ action: 1, allowed: false }, { action: VIEW, allowed: true }] },
    ])
  })
})

describe.each(['edit', 'read'] as const)('两种打开方式相同的部分（access = %s）', (access) => {
  const service = new EditorAuthzIoService(access)

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
  it.each([
    ['edit', true],
    ['read', false],
  ] as const)('把核心注入器里的 IAuthzIoService 换成按 access 回答的实例（%s：编辑 %s）', async (access, canEdit) => {
    const override = editorIdentityOverride(access)
    expect(override).toHaveLength(1)
    expect(override[0]?.[0]).toBe(IAuthzIoService)
    const service = (override[0]?.[1] as { useValue: unknown }).useValue
    expect(service).toBeInstanceOf(EditorAuthzIoService)
    await expect((service as EditorAuthzIoService).allowed({ ...workbookRequest, actions: [1, VIEW] as Action[] }))
      .resolves
      .toEqual([{ action: 1, allowed: canEdit }, { action: VIEW, allowed: true }])
  })

  it('每次创建都是新的实例：两份编辑器不共用授权服务', () => {
    const first = editorIdentityOverride('read')[0]?.[1] as { useValue: unknown }
    const second = editorIdentityOverride('read')[0]?.[1] as { useValue: unknown }
    expect(first.useValue).not.toBe(second.useValue)
  })
})
