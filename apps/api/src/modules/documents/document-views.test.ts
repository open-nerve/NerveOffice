// 文档详情、搜索结果与"与我共享"的视图（M2-P5 设计 §3.4(1)(2)(4)）："只凭授权时不给目录结构"只在这里实现：
// 途径是 grant 时不给所在的文件夹（详情）、不给文件夹与路径（搜索结果）；途径是 space 时照常给。"与我共享"一律不带文件夹。
// 个人空间存的名称（所有者建号时的显示名，可以伪造，规范 §2.4）哪里都不给：详情只给 id 与类型，搜索结果与"与我共享"只给所有者（S3）。
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
  // 代次不进任何响应（M3-P1）：不为 0，视图把它带出去时下面按原样核对的用例会失败
  writeEpoch: 4,
}

function team(memberRole: SpaceFacts['memberRole']): SpaceFacts {
  return { id: SPACE, type: 'team', name: '市场部', status: 'active', visibleToAll: false, owned: false, memberRole }
}

/** 别人的个人空间（存的名称可以伪造）；owned 为真时是看的人自己的 */
function personal(owned: boolean): SpaceFacts {
  return { id: SPACE, type: 'personal', name: '可以伪造的名称', status: 'active', visibleToAll: false, owned, memberRole: null }
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

  it('个人空间只给 id 与类型（M2-P5 S3）：存的名称不给——所有者本人看到的、只凭授权的人看到的都一样', () => {
    for (const [space, grant] of [[personal(true), undefined], [personal(false), 'viewer']] as const) {
      const access = documentAccessOf(space, grant)
      expect(access).toBeDefined()
      if (access === undefined)
        continue
      const detail = toDetail(ROW, access, BEN)
      expect(detail.space).toEqual({ id: SPACE, type: 'personal' })
      expect(JSON.stringify(detail)).not.toContain('可以伪造的名称')
    }
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

  it('途径是 grant：文件夹为空、路径是空数组（即使调用方给了路径）；团队空间给名称', () => {
    expect(toSearchHit(ROW, space, ['资料', '2026'], 'grant')).toEqual({
      id: ROW.id,
      title: '季度预算',
      type: 'sheet',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      space: { id: SPACE, type: 'team', name: '市场部' },
      folderId: null,
      folderPath: [],
      accessVia: 'grant',
    })
  })

  it('途径是 space：照常给文件夹与路径', () => {
    expect(toSearchHit(ROW, space, ['资料', '2026'], 'space')).toMatchObject({ folderId: FOLDER, folderPath: ['资料', '2026'], accessVia: 'space' })
  })
})

describe('toLocatedSpace：搜索结果与"与我共享"里的空间', () => {
  it('团队空间给名称；个人空间只给所有者的账户 id，不给存的名称（人名由 workspace 补上）', () => {
    expect(toLocatedSpace(team(null), null)).toEqual({ id: SPACE, type: 'team', name: '市场部' })
    expect(toLocatedSpace(personal(false), AMY)).toEqual({ id: SPACE, type: 'personal', ownerUserId: AMY })
  })

  it('个人空间没有所有者（数据不一致）：按意外错误处理', () => {
    expect(() => toLocatedSpace(personal(false), null)).toThrow(`个人空间没有所有者：${SPACE}`)
  })
})

describe('toSharedHit："与我共享"的一条', () => {
  it('摘要（不带文件夹）、所在的空间连同所有者、内容权限（访问策略算出，已按归档降级）', () => {
    const access = documentAccessOf(personal(false), 'editor')
    expect(access).toBeDefined()
    if (access === undefined)
      return
    expect(toSharedHit(ROW, access, AMY)).toEqual({
      id: ROW.id,
      title: '季度预算',
      type: 'sheet',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      space: { id: SPACE, type: 'personal', ownerUserId: AMY },
      contentRole: 'editor',
    })
    const archived = documentAccessOf({ ...team('admin'), status: 'archived' }, 'editor')
    expect(archived === undefined ? undefined : toSharedHit(ROW, archived, null).contentRole).toBe('viewer')
  })
})
