// 文档详情、搜索结果与"与我共享"的视图（M2-P5 设计 §3.4(1)(2)(4)）："只凭授权时不给目录结构"只在这里实现：
// 途径是 grant 时不给所在的文件夹（详情）、不给文件夹与路径（搜索结果）；途径是 space 时照常给。"与我共享"一律不带文件夹。
import type { SpaceFacts } from '../spaces/index.ts'
import type { DocumentRow } from './documents.repository.ts'
import { describe, expect, it } from 'vitest'
import { documentAccessOf } from './access-rules.ts'
import { toDetail, toLocatedSpace, toSearchHit, toSharedHit } from './document-views.ts'

const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const SPACE = '0199a2c4-0000-7000-8000-0000000000c1'
const FOLDER = '0199a2c4-0000-7000-8000-0000000000f1'
const NOW = new Date('2026-10-02T08:00:00.000Z')

const ROW: DocumentRow = {
  id: '0199a2c4-0000-7000-8000-0000000000d1',
  spaceId: SPACE,
  folderId: FOLDER,
  type: 'sheet',
  title: '季度预算',
  createdBy: AMY,
  createdAt: NOW,
  updatedAt: NOW,
  position: '2026-10-02T08:00:00.000000Z',
  revision: 2,
  unitId: 'unit-1',
  profile: 'sheet@1',
  formatVersion: 1,
}

function team(memberRole: SpaceFacts['memberRole']): SpaceFacts {
  return { id: SPACE, type: 'team', name: '市场部', status: 'active', visibleToAll: false, owned: false, memberRole }
}

describe('toDetail：只凭授权时不给所在的文件夹', () => {
  it('只凭编辑授权：folderId 为空、途径是 grant，其余照常（所在空间、修订号、内容的权限）', () => {
    const access = documentAccessOf(team(null), 'editor')
    expect(access).toBeDefined()
    if (access === undefined)
      return
    expect(toDetail(ROW, access, BEN)).toEqual({
      id: ROW.id,
      title: '季度预算',
      type: 'sheet',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      spaceId: SPACE,
      space: { id: SPACE, type: 'team', name: '市场部' },
      folderId: null,
      accessVia: 'grant',
      revision: 2,
      profile: 'sheet@1',
      formatVersion: 1,
      permissions: { canEdit: true, canRename: true, canCopy: true, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false, canShare: false },
    })
  })

  it('在空间里有角色（另有授权也一样）：照常给文件夹，途径是 space', () => {
    for (const [memberRole, grant] of [['viewer', undefined], ['viewer', 'editor'], ['admin', 'viewer']] as const) {
      const access = documentAccessOf(team(memberRole), grant)
      expect(access, `${memberRole} ${String(grant)}`).toBeDefined()
      if (access !== undefined)
        expect(toDetail(ROW, access, BEN), `${memberRole} ${String(grant)}`).toMatchObject({ folderId: FOLDER, accessVia: 'space' })
    }
  })
})

describe('toSearchHit：凭授权命中的一条不给目录结构', () => {
  const space = toLocatedSpace(team(null), null)

  it('途径是 grant：文件夹为空、路径是空数组（即使调用方给了路径）；空间带所有者的位置（团队空间为空）', () => {
    expect(toSearchHit(ROW, space, ['资料', '2026'], 'grant')).toEqual({
      id: ROW.id,
      title: '季度预算',
      type: 'sheet',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      space: { id: SPACE, type: 'team', name: '市场部', ownerUserId: null },
      folderId: null,
      folderPath: [],
      accessVia: 'grant',
    })
  })

  it('途径是 space：照常给文件夹与路径', () => {
    expect(toSearchHit(ROW, space, ['资料', '2026'], 'space')).toMatchObject({ folderId: FOLDER, folderPath: ['资料', '2026'], accessVia: 'space' })
  })
})

describe('toSharedHit："与我共享"的一条', () => {
  it('摘要（不带文件夹）、所在的空间连同所有者、内容权限（访问策略算出，已按归档降级）', () => {
    const personal: SpaceFacts = { id: SPACE, type: 'personal', name: '可以伪造的名称', status: 'active', visibleToAll: false, owned: false, memberRole: null }
    const access = documentAccessOf(personal, 'editor')
    expect(access).toBeDefined()
    if (access === undefined)
      return
    expect(toSharedHit(ROW, access, AMY)).toEqual({
      id: ROW.id,
      title: '季度预算',
      type: 'sheet',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      space: { id: SPACE, type: 'personal', name: '可以伪造的名称', ownerUserId: AMY },
      contentRole: 'editor',
    })
    const archived = documentAccessOf({ ...team('admin'), status: 'archived' }, 'editor')
    expect(archived === undefined ? undefined : toSharedHit(ROW, archived, null).contentRole).toBe('viewer')
  })
})
