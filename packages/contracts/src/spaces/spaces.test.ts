import { describe, expect, it } from 'vitest'
import {
  addSpaceMemberRequestSchema,
  changeSpaceMemberRoleRequestSchema,
  renameSpaceRequestSchema,
  SPACE_NAME_MAX_LENGTH,
  SPACE_ROLES,
  spaceListResponseSchema,
  spaceMemberListResponseSchema,
  spaceNameSchema,
  spaceViewSchema,
} from './spaces.ts'

const SPACE_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0f'

const view = {
  id: SPACE_ID,
  type: 'team',
  name: '市场部',
  status: 'active',
  visibleToAll: false,
  role: 'editor',
  permissions: { canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false },
}

describe('空间角色', () => {
  it('按从低到高排列：查看者、编辑者、空间管理员（比较高低用位置）', () => {
    expect(SPACE_ROLES).toEqual(['viewer', 'editor', 'admin'])
  })
})

describe('空间的名称', () => {
  it('去掉首尾空白之后 1–100 个字符（按码点计），不含控制字符', () => {
    expect(spaceNameSchema.parse(' 市场部 ')).toBe('市场部')
    expect(spaceNameSchema.safeParse('😀'.repeat(SPACE_NAME_MAX_LENGTH)).success).toBe(true)
    expect(spaceNameSchema.safeParse('😀'.repeat(SPACE_NAME_MAX_LENGTH + 1)).success).toBe(false)
    expect(spaceNameSchema.safeParse('   ').success).toBe(false)
    expect(spaceNameSchema.safeParse('市场\t部').success).toBe(false)
  })

  it('按名称的共用规则（M2-P6 复核 B2）：NFC 归一；拒绝改变文字方向的字符与换行符；不能只有看不见的字符', () => {
    expect(spaceNameSchema.parse('Jose\u0301')).toBe('Jos\u00E9')
    expect(spaceNameSchema.safeParse('市场\u2066部').success).toBe(false)
    expect(spaceNameSchema.safeParse('市场\u2029部').success).toBe(false)
    expect(spaceNameSchema.safeParse('\u115F\u1160').success).toBe(false)
    expect(spaceNameSchema.parse('\u05D3\u05D5\u05D3')).toBe('\u05D3\u05D5\u05D3')
  })

  it('名称里夹着看不见的字符（复验 N6）：零宽空格、韩文填充符、词连接符拒绝，与"研发部"看起来一样的名字不能并存；零宽连接符等放行', () => {
    for (const hidden of ['研\u200B发部', '研\u3164发部', '研发\u2060部'])
      expect(spaceNameSchema.safeParse(hidden).success, JSON.stringify(hidden)).toBe(false)
    expect(spaceNameSchema.parse('\u{1F468}\u200D\u{1F4BB} 研发部')).toBe('\u{1F468}\u200D\u{1F4BB} 研发部')
  })

  it('改名的请求只有名称', () => {
    expect(renameSpaceRequestSchema.parse({ name: ' 产品部 ' })).toEqual({ name: '产品部' })
    expect(renameSpaceRequestSchema.safeParse({ name: '产品部', visibleToAll: true }).success).toBe(false)
  })
})

describe('我能看到的空间', () => {
  it('带着调用者的角色与能做的操作；多出的字段被丢弃', () => {
    expect(spaceListResponseSchema.parse({ items: [{ ...view, memberCount: 3 }] })).toEqual({ items: [view] })
  })

  it('类型、状态与角色只接受登记过的取值', () => {
    expect(spaceViewSchema.safeParse({ ...view, type: 'shared' }).success).toBe(false)
    expect(spaceViewSchema.safeParse({ ...view, status: 'deleted' }).success).toBe(false)
    expect(spaceViewSchema.safeParse({ ...view, role: 'owner' }).success).toBe(false)
  })
})

describe('成员', () => {
  it('成员列表带空间的名称与状态、调用者能不能管理，条目带账户状态', () => {
    const list = {
      space: { id: SPACE_ID, name: '市场部', status: 'archived', visibleToAll: true },
      canManage: true,
      items: [{ user: { id: USER_ID, username: 'zhangsan', displayName: '张三' }, status: 'disabled', role: 'admin', createdAt: '2026-09-29T00:00:00.000Z' }],
    }
    expect(spaceMemberListResponseSchema.parse(list)).toEqual(list)
  })

  it('添加：账户 id 与角色；调整：只有角色', () => {
    expect(addSpaceMemberRequestSchema.parse({ userId: USER_ID, role: 'viewer' })).toEqual({ userId: USER_ID, role: 'viewer' })
    expect(addSpaceMemberRequestSchema.safeParse({ userId: 'zhangsan', role: 'viewer' }).success).toBe(false)
    expect(addSpaceMemberRequestSchema.safeParse({ userId: USER_ID, role: 'owner' }).success).toBe(false)
    expect(changeSpaceMemberRoleRequestSchema.safeParse({ role: 'editor' }).success).toBe(true)
    expect(changeSpaceMemberRoleRequestSchema.safeParse({ role: 'editor', userId: USER_ID }).success).toBe(false)
  })
})
