import type { Transaction } from '../database/index.ts'
import type { SpaceFacts } from '../spaces/index.ts'
import type { DocumentAccessPolicy, SpaceAccess } from './document-access-policy.ts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { documentAccessIn, requireAccess, requireCreateTarget, requireDocumentContent, requireSpaceContent, requireSpaceManagement, SHARING_FROZEN_MESSAGE } from './document-access-policy.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, member, TEAM_SPACE } from './documents.test-support.ts'

const MISSING = '0199a2c4-0000-7000-8000-0000000000ff'
const ZERO = '00000000-0000-0000-0000-000000000000'
const ADMIN = { userId: ALICE, systemAdmin: true }

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('EffectiveAccessPolicy', () => {
  it('文档：空间事实与授权各查一次（先空间、后授权），在事务里判断时都走同一个事务；按所在空间的有效角色', async () => {
    const store = new FakeStore()
    const transaction = {} as Transaction
    const access = await store.policy.accessOf(ALICE, { id: 'd1', spaceId: ALICE_SPACE, createdBy: ALICE }, transaction)
    expect(access).toMatchObject({ spaceRole: 'admin', contentRole: 'admin', accessVia: 'space' })
    expect(access?.space).toMatchObject({ id: ALICE_SPACE, type: 'personal' })
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(1)
    expect(store.spaces.accessFactsOf).toHaveBeenCalledWith(ALICE, ALICE_SPACE, { transaction })
    expect(store.grants.roleOf).toHaveBeenCalledTimes(1)
    expect(store.grants.roleOf).toHaveBeenCalledWith('d1', ALICE, transaction)
    expect(store.spaces.accessFactsOf.mock.invocationCallOrder[0]).toBeLessThan(store.grants.roleOf.mock.invocationCallOrder[0] ?? 0)
    expect(await store.policy.accessOf(BOB, { id: 'd1', spaceId: ALICE_SPACE, createdBy: ALICE })).toBeUndefined()
  })

  it('文档并上单独授权（M2-P5）：在空间里没有角色、只凭授权时途径是 grant；授权给别人、给别的文档都不算', async () => {
    const store = new FakeStore()
    const document = { id: 'd1', spaceId: TEAM_SPACE, createdBy: ALICE }
    store.setGrant('d1', BOB, 'editor')
    expect(await store.policy.accessOf(BOB, document)).toMatchObject({ spaceRole: undefined, contentRole: 'editor', accessVia: 'grant', space: { id: TEAM_SPACE } })
    expect(await store.policy.accessOf(ALICE, document)).toBeUndefined()
    expect(await store.policy.accessOf(BOB, { ...document, id: 'd2' })).toBeUndefined()
    // 归档之后授权同样降为查看者；取消之后看不到
    store.space(TEAM_SPACE).status = 'archived'
    expect(await store.policy.accessOf(BOB, document)).toMatchObject({ contentRole: 'viewer', accessVia: 'grant' })
    store.setGrant('d1', BOB, undefined)
    expect(await store.policy.accessOf(BOB, document)).toBeUndefined()
  })

  it('空间不看单独授权：只凭授权的人看不到那个空间（空间页、按空间列出、文件夹、回收站都经它）', async () => {
    const store = new FakeStore()
    store.setGrant('d1', BOB, 'editor')
    expect(await store.policy.spaceAccessOf(member(BOB), TEAM_SPACE)).toBeUndefined()
    expect((await errorOf(requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'view'))).code).toBe('NOT_FOUND')
    expect((await store.policy.visibleSpaces(member(BOB))).map(access => access.space.id)).toEqual([BOB_SPACE])
    expect(store.grants.roleOf).not.toHaveBeenCalled()
  })

  it('空间：没有角色的看不到；没有加入的系统管理员看得到团队空间的管理面，看不到个人空间', async () => {
    const store = new FakeStore()
    expect(await store.policy.spaceAccessOf(member(ALICE), TEAM_SPACE)).toBeUndefined()
    expect(await store.policy.spaceAccessOf(ADMIN, TEAM_SPACE)).toMatchObject({ role: undefined, permissions: { canCreateDocuments: false, canManageMembers: true } })
    expect(await store.policy.spaceAccessOf(ADMIN, BOB_SPACE)).toBeUndefined()
    expect(await store.policy.spaceAccessOf(ADMIN, MISSING)).toBeUndefined()
  })

  it('我能看到的空间：只有有内容权限的；系统管理员没有加入的团队空间不在里面', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, BOB, 'editor')
    expect((await store.policy.visibleSpaces(member(BOB))).map(access => [access.space.id, access.role])).toEqual([[BOB_SPACE, 'admin'], [TEAM_SPACE, 'editor']])
    expect((await store.policy.visibleSpaces(ADMIN)).map(access => access.space.id)).toEqual([ALICE_SPACE])
    store.space(TEAM_SPACE).visibleToAll = true
    expect((await store.policy.visibleSpaces(ADMIN)).map(access => [access.space.id, access.role])).toEqual([[ALICE_SPACE, 'admin'], [TEAM_SPACE, 'viewer']])
  })

  it('一批文档（M2-P5，"与我共享"）：空间事实一条语句按一批 id 取，规则同 documentAccessOf；授权由调用方带来、不另读；看不到的不在结果里；带所有者', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    const accesses = await store.policy.accessOfMany(BOB, [
      { document: { id: 'shared-team', spaceId: TEAM_SPACE, createdBy: ALICE }, grant: 'editor' },
      { document: { id: 'shared-personal', spaceId: ALICE_SPACE, createdBy: ALICE }, grant: 'viewer' },
      { document: { id: 'no-grant', spaceId: ALICE_SPACE, createdBy: ALICE }, grant: undefined },
      { document: { id: 'missing-space', spaceId: MISSING, createdBy: ALICE }, grant: 'editor' },
    ])
    expect([...accesses.keys()]).toEqual(['shared-team', 'shared-personal'])
    expect(accesses.get('shared-team')).toMatchObject({ access: { spaceRole: 'viewer', contentRole: 'editor', accessVia: 'space' }, ownerUserId: null })
    expect(accesses.get('shared-personal')).toMatchObject({ access: { spaceRole: undefined, contentRole: 'viewer', accessVia: 'grant', space: { id: ALICE_SPACE } }, ownerUserId: ALICE })
    expect(store.spaces.accessFactsOfMany).toHaveBeenCalledTimes(1)
    expect(store.spaces.accessFactsOfMany).toHaveBeenCalledWith(BOB, [TEAM_SPACE, ALICE_SPACE, ALICE_SPACE, MISSING])
    expect(store.spaces.accessFactsOf).not.toHaveBeenCalled()
    expect(store.grants.roleOf).not.toHaveBeenCalled()
    // 归档同样降级（同一个纯函数）；空的一批不查询
    store.space(TEAM_SPACE).status = 'archived'
    expect((await store.policy.accessOfMany(BOB, [{ document: { id: 'shared-team', spaceId: TEAM_SPACE, createdBy: ALICE }, grant: 'editor' }])).get('shared-team')?.access.contentRole).toBe('viewer')
    expect((await store.policy.accessOfMany(BOB, [])).size).toBe(0)
    expect(store.spaces.accessFactsOfMany).toHaveBeenCalledTimes(2)
  })
})

describe('requireAccess', () => {
  it('能访问：文档与有效角色', async () => {
    const store = new FakeStore()
    const document = { id: 'd1', spaceId: ALICE_SPACE, createdBy: ALICE }
    expect(await requireAccess(store.policy, ALICE, document)).toMatchObject({ document, access: { spaceRole: 'admin', contentRole: 'admin' } })
  })

  it('别人的与不存在的：同一个 NOT_FOUND；不存在时也用全零的空间与全零的文档照样查空间事实与授权两次（M2-P5 设计 §3.1）', async () => {
    const store = new FakeStore()
    const others = await errorOf(requireAccess(store.policy, ALICE, { id: 'd2', spaceId: BOB_SPACE, createdBy: BOB }))
    const missing = await errorOf(requireAccess(store.policy, ALICE, undefined))
    expect([others.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(store.spaces.accessFactsOf.mock.calls.map(call => call[1])).toEqual([BOB_SPACE, ZERO])
    expect(store.grants.roleOf.mock.calls.map(call => call.slice(0, 2))).toEqual([['d2', ALICE], [ZERO, ALICE]])
  })
})

describe('requireDocumentContent：保存（edit）', () => {
  it('查看者不能保存，编辑者与空间管理员可以；归档的空间里说明"空间已归档"，与其他操作一致（M2-P6 复核 A 的 G3）', async () => {
    const store = new FakeStore()
    const document = { id: 'd1', spaceId: TEAM_SPACE, createdBy: ALICE }
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.setMember(TEAM_SPACE, BOB, 'editor')
    expect((await requireDocumentContent(store.policy, ALICE, document, ['edit'])).permissions.canEdit).toBe(true)
    expect((await requireDocumentContent(store.policy, BOB, document, ['edit'])).permissions.canEdit).toBe(true)
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['edit']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能保存' })
    store.space(TEAM_SPACE).status = 'archived'
    for (const userId of [ALICE, BOB])
      expect(await errorOf(requireDocumentContent(store.policy, userId, document, ['edit']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
  })
})

describe('requireDocumentContent：只凭授权的人（M2-P5 设计 §3.4(1)）', () => {
  const document = { id: 'd1', spaceId: TEAM_SPACE, createdBy: BOB }

  it('编辑授权：保存、改名、复制可以；空间内移动、跨空间移动、删除一律 403，说明是"单独分享给你的"——他是创建人也不能删', async () => {
    const store = new FakeStore()
    store.setGrant('d1', BOB, 'editor')
    const allowed = await requireDocumentContent(store.policy, BOB, document, ['edit', 'rename', 'copy'])
    expect(allowed.access).toMatchObject({ accessVia: 'grant', contentRole: 'editor' })
    expect(allowed.permissions).toMatchObject({ canEdit: true, canRename: true, canCopy: true, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false, canShare: false })
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['moveWithinSpace']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能移动' })
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['moveAcrossSpaces']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能移动' })
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['delete']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能删除' })
    // 一次要求多项：改名可以、移动不行，整个请求 403
    expect((await errorOf(requireDocumentContent(store.policy, BOB, document, ['rename', 'moveWithinSpace']))).code).toBe('PERMISSION_DENIED')
  })

  it('查看授权：只能读与复制，保存与改名按内容权限的说明拒绝', async () => {
    const store = new FakeStore()
    store.setGrant('d1', BOB, 'viewer')
    expect((await requireDocumentContent(store.policy, BOB, document, ['copy'])).permissions.canCopy).toBe(true)
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['edit']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能保存' })
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['rename']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '没有给这份文档改名的权限' })
  })

  it('归档：编辑授权也只能查看，内容操作说明"空间已归档"；结构性操作仍说明是单独分享的（恢复之后他照样不能做）', async () => {
    const store = new FakeStore()
    store.setGrant('d1', BOB, 'editor')
    store.space(TEAM_SPACE).status = 'archived'
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['edit']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['delete']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能删除' })
  })

  it('空间里有角色的人另有授权：结构性操作按空间角色的说明（不是"单独分享给你的"）', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    store.setGrant('d1', ALICE, 'editor')
    const checked = await requireDocumentContent(store.policy, ALICE, document, ['edit'])
    expect(checked.access).toMatchObject({ accessVia: 'space', spaceRole: 'viewer', contentRole: 'editor' })
    expect(await errorOf(requireDocumentContent(store.policy, ALICE, document, ['moveWithinSpace']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '没有移动这份文档的权限' })
  })
})

describe('requireDocumentContent：分享（share，M2-P5 设计 §3.2）', () => {
  const document = { id: 'd1', spaceId: TEAM_SPACE, createdBy: ALICE }

  it('只看空间角色：空间管理员与个人空间的所有者可以；编辑者与查看者 403（只有空间管理员能分享）——另有编辑授权也不行', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    expect((await requireDocumentContent(store.policy, ALICE, document, ['share'])).permissions.canShare).toBe(true)
    expect((await requireDocumentContent(store.policy, BOB, { id: 'd2', spaceId: BOB_SPACE, createdBy: BOB }, ['share'])).permissions.canShare).toBe(true)
    for (const role of ['editor', 'viewer'] as const) {
      store.setMember(TEAM_SPACE, BOB, role)
      store.setGrant('d1', BOB, 'editor')
      expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['share'])), role).toMatchObject({ code: 'PERMISSION_DENIED', message: '只有空间管理员能分享这份文档' })
    }
  })

  it('归档的空间里冻结：空间管理员与成员都给冻结的说明（不是默认的"只能查看"）；只凭授权的人给他自己的说明，归档与否都一样', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.setGrant('d1', BOB, 'editor')
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['share']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能再分享给别人' })
    store.space(TEAM_SPACE).status = 'archived'
    expect(await errorOf(requireDocumentContent(store.policy, ALICE, document, ['share']))).toMatchObject({ code: 'PERMISSION_DENIED', message: SHARING_FROZEN_MESSAGE })
    expect(await errorOf(requireDocumentContent(store.policy, BOB, document, ['share']))).toMatchObject({ code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能再分享给别人' })
    // 其他操作在归档时仍是默认的说法
    expect(await errorOf(requireDocumentContent(store.policy, ALICE, document, ['rename']))).toMatchObject({ message: '空间已归档，只能查看' })
  })
})

describe('documentAccessIn：刚放进一个空间的文档（新建、复制出来的、跨空间移进来的）', () => {
  it('按调用者在那个空间的访问：空间角色就是内容权限，途径是空间', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, BOB, 'editor')
    const target = await requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'createDocuments')
    expect(documentAccessIn(target)).toEqual({ spaceRole: 'editor', contentRole: 'editor', accessVia: 'space', space: target.space })
  })
})

describe('requireSpaceContent', () => {
  it('看不到、不存在、没有加入的系统管理员：同一个 NOT_FOUND，查询相同', async () => {
    const store = new FakeStore()
    const errors = [
      await errorOf(requireSpaceContent(store.policy, member(ALICE), TEAM_SPACE, 'view')),
      await errorOf(requireSpaceContent(store.policy, member(ALICE), MISSING, 'view')),
      await errorOf(requireSpaceContent(store.policy, ADMIN, TEAM_SPACE, 'view')),
      await errorOf(requireSpaceContent(store.policy, ADMIN, BOB_SPACE, 'createDocuments')),
    ]
    expect(errors.map(error => [error.code, error.message])).toEqual(Array.from({ length: 4 }, () => ['NOT_FOUND', errors[0]?.message]))
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(4)
  })

  it('查看者能看、不能新建；归档时说明原因', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'view')).toMatchObject({ role: 'viewer' })
    expect(await errorOf(requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'createDocuments'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '没有在这个空间里新建的权限' })
    store.setMember(TEAM_SPACE, BOB, 'editor')
    expect(await requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'createDocuments')).toMatchObject({ role: 'editor' })
    store.space(TEAM_SPACE).status = 'archived'
    expect(await errorOf(requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'createDocuments'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
  })
})

/**
 * 只回答一个空间访问的假策略：两个"新建"权限位可以分别设置。
 * 真实规则里它们今天始终相同（access-rules.ts），所以只有把它们分开，才看得出判的是哪一个（审查 A 建议 5）。
 */
function policyWithCreate(permissions: { readonly canCreateDocuments: boolean, readonly canCreateFolders: boolean }): DocumentAccessPolicy {
  const space: SpaceFacts = { id: TEAM_SPACE, type: 'team', name: '市场部', status: 'active', visibleToAll: false, owned: false, memberRole: 'editor' }
  const access: SpaceAccess = {
    space,
    role: 'editor',
    permissions: { ...permissions, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false },
  }
  return { accessOf: async () => undefined, spaceAccessOf: async () => access, visibleSpaces: async () => [], accessOfMany: async () => new Map() }
}

describe('requireCreateTarget', () => {
  it('判的是这次要新建的那一种权限：搬（复制）文档看 canCreateDocuments，搬文件夹看 canCreateFolders', async () => {
    const onlyDocuments = policyWithCreate({ canCreateDocuments: true, canCreateFolders: false })
    expect(await requireCreateTarget(onlyDocuments, member(ALICE), TEAM_SPACE, 'createDocuments')).toMatchObject({ role: 'editor' })
    expect(await errorOf(requireCreateTarget(onlyDocuments, member(ALICE), TEAM_SPACE, 'createFolders')))
      .toMatchObject({ code: 'PERMISSION_DENIED', message: '没有在目标空间里新建的权限' })

    const onlyFolders = policyWithCreate({ canCreateDocuments: false, canCreateFolders: true })
    expect(await requireCreateTarget(onlyFolders, member(ALICE), TEAM_SPACE, 'createFolders')).toMatchObject({ role: 'editor' })
    expect((await errorOf(requireCreateTarget(onlyFolders, member(ALICE), TEAM_SPACE, 'createDocuments'))).code).toBe('PERMISSION_DENIED')
  })
})

describe('requireSpaceManagement', () => {
  it('看不到的：NOT_FOUND；有角色却不是空间管理员：PERMISSION_DENIED；空间管理员与系统管理员：可以', async () => {
    const store = new FakeStore()
    expect((await errorOf(requireSpaceManagement(store.policy, member(ALICE), TEAM_SPACE, 'manageMembers'))).code).toBe('NOT_FOUND')
    store.setMember(TEAM_SPACE, BOB, 'editor')
    expect(await errorOf(requireSpaceManagement(store.policy, member(BOB), TEAM_SPACE, 'manageMembers'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只有空间管理员能管理成员' })
    expect(await requireSpaceManagement(store.policy, member(BOB), TEAM_SPACE, 'viewMembers')).toMatchObject({ role: 'editor' })
    store.setMember(TEAM_SPACE, BOB, 'admin')
    expect(await requireSpaceManagement(store.policy, member(BOB), TEAM_SPACE, 'rename')).toMatchObject({ role: 'admin' })
    expect(await requireSpaceManagement(store.policy, ADMIN, TEAM_SPACE, 'manageMembers')).toMatchObject({ role: undefined })
  })

  it('个人空间：所有者 PERMISSION_DENIED（没有成员、不能改名），系统管理员 NOT_FOUND', async () => {
    const store = new FakeStore()
    expect(await errorOf(requireSpaceManagement(store.policy, member(ALICE), ALICE_SPACE, 'viewMembers'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '个人空间没有成员' })
    expect((await errorOf(requireSpaceManagement(store.policy, member(ALICE), ALICE_SPACE, 'rename'))).code).toBe('PERMISSION_DENIED')
    expect((await errorOf(requireSpaceManagement(store.policy, { userId: BOB, systemAdmin: true }, ALICE_SPACE, 'manageMembers'))).code).toBe('NOT_FOUND')
  })

  it('归档：原来的空间管理员不能管理，说明原因；系统管理员照样能', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, BOB, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect(await errorOf(requireSpaceManagement(store.policy, member(BOB), TEAM_SPACE, 'manageMembers'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    expect(await requireSpaceManagement(store.policy, { userId: BOB, systemAdmin: true }, TEAM_SPACE, 'manageMembers')).toMatchObject({ role: 'viewer' })
  })
})
