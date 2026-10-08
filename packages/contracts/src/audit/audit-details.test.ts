// 审计明细按动作的严格结构（M2-P6 复核 M-1）：每个动作都有结构；多余的键（例如标题、名称）一律拒绝。
import { describe, expect, it } from 'vitest'
import { SPACE_NAME_MAX_LENGTH } from '../spaces/spaces.ts'
import { auditDetailsSchema } from './audit-details.ts'
import { AUDIT_ACTIONS, AUDIT_DETAILS_MAX_BYTES } from './audit.ts'

const ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const OTHER = '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f'

/** UTF-8 编码之后的字节数（contracts 不用 Node 与浏览器特有的 API，这里按码点自己算） */
function utf8Length(text: string): number {
  return [...text].reduce((total, char) => {
    const code = char.codePointAt(0) ?? 0
    return total + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4)
  }, 0)
}

function accepts(action: string, details: unknown): boolean {
  return auditDetailsSchema.safeParse({ action, details }).success
}

describe('审计明细的结构', () => {
  it('AUDIT_ACTIONS 里的每个动作都有明细的结构', () => {
    const covered = new Set(auditDetailsSchema.options.map(option => option.shape.action.value))
    expect(AUDIT_ACTIONS.filter(action => !covered.has(action))).toEqual([])
    expect(covered.size).toBe(AUDIT_ACTIONS.length)
  })

  it('不认识的动作拒绝', () => {
    expect(accepts('documents.archived', {})).toBe(false)
  })

  it.each([
    ['documents.renamed', { spaceId: ID, folderId: null }],
    ['folders.created', { spaceId: ID, parentId: OTHER }],
    ['folders.renamed', { spaceId: ID, parentId: null }],
    ['documents.purged', { spaceId: ID, trashEntryId: OTHER, folders: 0, documents: 1, cascadedEntries: 0 }],
    ['folders.purged', { spaceId: ID, trashEntryId: OTHER, folders: 3, documents: 3, cascadedEntries: 2 }],
  ])('%s：只有位置、份数与删除单元', (action, details) => {
    expect(accepts(action, details)).toBe(true)
  })

  it.each([
    ['documents.renamed', { spaceId: ID, folderId: null, from: '周报', to: '月报' }],
    ['documents.renamed', { spaceId: ID, folderId: null, title: '月报' }],
    ['folders.created', { spaceId: ID, parentId: null, name: '资料' }],
    ['folders.renamed', { spaceId: ID, parentId: null, from: '资料', to: '档案' }],
    ['documents.purged', { spaceId: ID, trashEntryId: OTHER, folders: 0, documents: 1, cascadedEntries: 0, title: '周报' }],
    ['folders.purged', { spaceId: ID, trashEntryId: OTHER, folders: 1, documents: 0, cascadedEntries: 0, title: '资料' }],
  ])('%s：带着标题或名称时拒绝', (action, details) => {
    expect(accepts(action, details)).toBe(false)
  })

  it('没有补充信息的动作：只收空对象', () => {
    expect(accepts('users.disabled', {})).toBe(true)
    expect(accepts('users.disabled', { reason: 'x' })).toBe(false)
  })

  it('邀请的作废：手动（空）、过期、重发、签发人离任（M2-P6 复核 A2）四种写法，别的不收', () => {
    expect(accepts('users.invitation_revoked', {})).toBe(true)
    expect(accepts('users.invitation_revoked', { expired: true })).toBe(true)
    expect(accepts('users.invitation_revoked', { reissued: true })).toBe(true)
    expect(accepts('users.invitation_revoked', { reason: 'issuer_disabled' })).toBe(true)
    expect(accepts('users.invitation_revoked', { reason: 'issuer_no_longer_admin' })).toBe(true)
    expect(accepts('users.invitation_revoked', { expired: false })).toBe(false)
    expect(accepts('users.invitation_revoked', { username: 'amy' })).toBe(false)
    expect(accepts('users.invitation_revoked', { reason: 'account_disabled' })).toBe(false)
    expect(accepts('users.invitation_revoked', { reason: 'issuer_disabled', username: 'amy' })).toBe(false)
  })

  it('重置链接的作废：重置的 id 与原因（签发新的、停用账户、签发人被停用或不再是系统管理员）', () => {
    for (const reason of ['reissued', 'account_disabled', 'issuer_disabled', 'issuer_no_longer_admin'])
      expect(accepts('users.password_reset_revoked', { passwordResetId: ID, reason }), reason).toBe(true)
    expect(accepts('users.password_reset_revoked', { passwordResetId: ID, reason: 'expired' })).toBe(false)
    expect(accepts('users.password_reset_revoked', { reason: 'reissued' })).toBe(false)
  })

  it('解除登录锁定（M2-P6 复核 A1）：没有补充信息，清掉了哪些来源不记', () => {
    expect(accepts('users.login_unlocked', {})).toBe(true)
    expect(accepts('users.login_unlocked', { username: 'amy' })).toBe(false)
    expect(accepts('users.login_unlocked', { clientIp: '203.0.113.7' })).toBe(false)
  })

  it('单独授权（M2-P5）：与成员的三个动作同形——被授权人与角色，调整记前后的角色；角色只有查看者与编辑者，不收标题', () => {
    expect(accepts('documents.shared', { userId: ID, role: 'viewer' })).toBe(true)
    expect(accepts('documents.share_changed', { userId: ID, from: 'editor', to: 'viewer' })).toBe(true)
    expect(accepts('documents.share_revoked', { userId: ID, role: 'editor' })).toBe(true)
    // 授权最高只到编辑者
    expect(accepts('documents.shared', { userId: ID, role: 'admin' })).toBe(false)
    expect(accepts('documents.share_changed', { userId: ID, from: 'viewer', to: 'admin' })).toBe(false)
    // 少了被授权人、id 不是 UUID、多了标题都拒绝
    expect(accepts('documents.shared', { role: 'viewer' })).toBe(false)
    expect(accepts('documents.share_revoked', { userId: 'amy', role: 'viewer' })).toBe(false)
    expect(accepts('documents.shared', { userId: ID, role: 'viewer', title: '周报' })).toBe(false)
    expect(accepts('documents.share_changed', { userId: ID, role: 'viewer' })).toBe(false)
  })

  it('US-M3-11 另存为副本（M3-P2）：原文档与副本所在的空间，两项都要；不收标题与文件夹', () => {
    expect(accepts('documents.conflict_copied', { sourceId: ID, spaceId: OTHER })).toBe(true)
    expect(accepts('documents.conflict_copied', { sourceId: ID })).toBe(false)
    expect(accepts('documents.conflict_copied', { spaceId: OTHER })).toBe(false)
    expect(accepts('documents.conflict_copied', { sourceId: 'x', spaceId: OTHER })).toBe(false)
    expect(accepts('documents.conflict_copied', { sourceId: ID, spaceId: OTHER, title: '周报（冲突副本 2026-10-04 14:30）' })).toBe(false)
    expect(accepts('documents.conflict_copied', { sourceId: ID, spaceId: OTHER, folderId: null })).toBe(false)
  })

  it('US-M3-09 强制接管（M3-P5 设计 §3.8）：只有被接管的人；不收标题、令牌、接管方式与别的字段', () => {
    expect(accepts('documents.edit_taken_over', { holderId: ID })).toBe(true)
    expect(accepts('documents.edit_taken_over', {})).toBe(false)
    expect(accepts('documents.edit_taken_over', { holderId: 'amy' })).toBe(false)
    expect(accepts('documents.edit_taken_over', { holderId: ID, title: '周报' })).toBe(false)
    expect(accepts('documents.edit_taken_over', { holderId: ID, token: 'x'.repeat(43) })).toBe(false)
    expect(accepts('documents.edit_taken_over', { holderId: ID, takeover: 'forced' })).toBe(false)
    expect(accepts('documents.edit_taken_over', { holderId: ID, spaceId: OTHER })).toBe(false)
  })

  it('US-M3-17 吊销本机密钥（M3-P6 设计 §3.5）：只有被吊销的那一版（从 1 起的整数）；不收密钥材料、主密钥的标识、下一版与别的字段', () => {
    expect(accepts('users.local_key_revoked', { version: 1 })).toBe(true)
    expect(accepts('users.local_key_revoked', { version: 7 })).toBe(true)
    expect(accepts('users.local_key_revoked', {})).toBe(false)
    for (const version of [0, -1, 1.5, '1'])
      expect(accepts('users.local_key_revoked', { version }), String(version)).toBe(false)
    expect(accepts('users.local_key_revoked', { version: 1, key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })).toBe(false)
    expect(accepts('users.local_key_revoked', { version: 1, wrappedKey: 'x' })).toBe(false)
    expect(accepts('users.local_key_revoked', { version: 1, masterKeyId: '00112233445566778899aabbccddeeff' })).toBe(false)
    expect(accepts('users.local_key_revoked', { version: 1, nextVersion: 2 })).toBe(false)
  })

  it('类型不对拒绝：id 不是 UUID、份数是负数或小数、原因不在列表里', () => {
    expect(accepts('documents.deleted', { spaceId: 'x', folderId: null, trashEntryId: OTHER })).toBe(false)
    expect(accepts('folders.deleted', { spaceId: ID, parentId: null, trashEntryId: OTHER, folders: -1, documents: 0 })).toBe(false)
    expect(accepts('folders.deleted', { spaceId: ID, parentId: null, trashEntryId: OTHER, folders: 1.5, documents: 0 })).toBe(false)
    expect(accepts('auth.login_failed', { reason: 'guessed' })).toBe(false)
  })

  it('团队空间的改名记改动前后的名称（系统管理员在管理界面本来就看得到），名称按空间名称的上限', () => {
    expect(accepts('spaces.renamed', { from: '市场部', to: '市场与品牌部' })).toBe(true)
    expect(accepts('spaces.renamed', { from: '', to: '市场部' })).toBe(false)
    expect(accepts('spaces.renamed', { from: '市场部', to: 'x'.repeat(101) })).toBe(false)
  })

  // 审计与业务写在同一个事务里，明细超长会把业务一起回滚（M2-P4 审查 A1）：每个字段都有上界，没有数组与嵌套，
  // 最长的一种（团队空间改名，前后各 100 个 4 字节的字符）也要在上限之内
  it('最长的明细也在 AUDIT_DETAILS_MAX_BYTES 之内', () => {
    const name = '\u{1F600}'.repeat(SPACE_NAME_MAX_LENGTH)
    const parsed = auditDetailsSchema.parse({ action: 'spaces.renamed', details: { from: name, to: name } })
    expect(utf8Length(JSON.stringify(parsed.details))).toBeLessThanOrEqual(AUDIT_DETAILS_MAX_BYTES)
  })
})
