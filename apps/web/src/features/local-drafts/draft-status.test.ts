import type { DocumentDetail } from '@nerve-office/contracts'
import type { RecoveryView } from '../../shared/local-drafts/document-recovery.ts'
import type { DraftCatalogRow } from '../../shared/local-drafts/draft-catalog.ts'
import { describe, expect, it } from 'vitest'
import { draftStatus } from './draft-status.ts'

const ready: RecoveryView = { stage: 'ready', decision: { kind: 'restore', baseRevision: 1, formulasPending: false, reason: 'fast-forward' }, updatedAt: 1, operation: undefined, cleanup: undefined, copy: { kind: 'idle' }, notice: undefined, problem: undefined }
const row: DraftCatalogRow = { documentId: 'doc', title: '标题', updatedAt: 1, mirrorOnly: false, access: 'accessible', recovery: ready }

describe('本机草稿事实的页面说明', () => {
  it('只有镜像而主记录不在时说明待核对，不显示无草稿', () => {
    expect(draftStatus({ ...row, mirrorOnly: true, recovery: { ...ready, decision: { kind: 'none' } } }).summary).toContain('本机备份')
  })

  it('删库成功但镜像忙时，完成说明必须包含尚未清理的镜像', () => {
    const status = draftStatus({ ...row, recovery: { ...ready, stage: 'finished', cleanup: { kind: 'removed', mirror: { kind: 'busy' } } } })
    expect(status.summary).toContain('主记录已清除')
    expect(status.details).toContain('本机备份尚未清理完成')
    expect(status.canCopy).toBe(false)
    expect(status.canRestore).toBe(false)
  })

  it('原件已变化时只引导重新检查，旧状态不继续开放恢复/复制', () => {
    const status = draftStatus({ ...row, recovery: { ...ready, cleanup: { kind: 'changed' }, problem: 'changed' } })
    expect(status.summary).toContain('已经变化')
    expect(status.canCopy).toBe(false)
    expect(status.canRestore).toBe(false)
  })

  it('网络未知清除旧标题后，旧 restore 不冒充当前恢复资格', () => {
    const status = draftStatus({ ...row, title: undefined, access: 'unknown' })
    expect(status.summary).toContain('无法确认')
    expect(status.canRestore).toBe(false)
    expect(status.canCopy).toBe(false)
  })

  it('较新格式只能更新页面，不能放弃或复制', () => {
    const status = draftStatus({ ...row, recovery: { ...ready, decision: { kind: 'preserve', reason: 'newer-format' } } })
    expect(status.canReload).toBe(true)
    expect(status.canDiscard).toBe(false)
    expect(status.canCopy).toBe(false)
  })

  it.each(['read-only', 'conflict'] as const)('%s 只给副本，恢复仍由编辑器判断', (reason) => {
    const status = draftStatus({ ...row, recovery: { ...ready, decision: { kind: 'copy', reason } } })
    expect(status.canCopy).toBe(true)
    expect(status.canDiscard).toBe(true)
    expect(status.canRestore).toBe(false)
  })

  it.each(['unreadable', 'expired', 'revoked', 'corrupted', 'malformed'] as const)('清理 %s 后保留原因', (reason) => {
    const status = draftStatus({ ...row, recovery: { ...ready, stage: 'finished', decision: { kind: 'remove', reason } } })
    expect(status.summary).toMatch(/清除|清理/)
    expect(status.canDiscard).toBe(false)
  })

  it('旧保存已确认但清理失败时，不声称本机已经清理', () => {
    const status = draftStatus({ ...row, recovery: { ...ready, decision: { kind: 'confirmed', revision: 2 }, cleanup: { kind: 'quota' } } })
    expect(status.summary).toContain('尚待清理')
  })

  it('副本已建但原件变化，两项事实都必须保留', () => {
    const status = draftStatus({ ...row, recovery: { ...ready, copy: { kind: 'done', document: { id: 'copy', title: '副本' } as DocumentDetail }, cleanup: { kind: 'changed' }, problem: 'changed' } })
    expect(`${status.summary} ${status.details}`).toContain('副本已保存')
    expect(`${status.summary} ${status.details}`).toContain('新内容仍保留')
  })
})
