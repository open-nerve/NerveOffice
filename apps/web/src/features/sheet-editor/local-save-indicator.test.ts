import type { ConnectionView } from '../../shared/lib/connection-state.ts'
import type { LocalSaveView } from './editing-session.ts'
import type { DraftMemoryReason } from './working-draft.ts'
import { describe, expect, it } from 'vitest'
import { sampleMeta } from '../../shared/outbox/draft-record.test-support.ts'
import { localSaveIndicator } from './local-save-indicator.ts'

const ONLINE: ConnectionView = { browserOnline: true, available: true, problem: undefined, since: undefined, generation: 0 }
const OFFLINE: ConnectionView = { ...ONLINE, browserOnline: false, available: false, problem: 'offline', since: 1_000 }
const LOCAL: LocalSaveView = {
  draft: { kind: 'working', ref: { sessionId: 'session', serial: 1, draftSeq: 1, editorSeq: 1, bytes: 3, formulasPending: false }, local: { kind: 'persisted', mirror: { kind: 'mirrored' } }, summary: undefined },
  storage: { kind: 'persistent', reason: undefined, hostKind: 'worker', mirror: { kind: 'mirrored' }, persistence: { kind: 'granted' } },
  coversCurrent: true,
  unsaved: true,
  enabled: true,
}

describe('本机事实与连接提示', () => {
  it('当前正文已云端确认但删除回包丢失：不再宣称仍有本机记录，也不宣称已清除', () => {
    if (LOCAL.draft.kind !== 'working')
      throw new Error('夹具必须有草稿')
    const draft = { ...LOCAL.draft, summary: { kind: 'ready' as const, ref: LOCAL.draft.ref, contentSeq: 1, digest: undefined, baseRevision: 8, format: sampleMeta().format, local: LOCAL.draft.local, confirmedRevision: 8 }, metadataIssue: { operation: 'confirm' as const, reason: 'unavailable' as const } }
    const result = localSaveIndicator({ ...LOCAL, unsaved: false, draft }, ONLINE, 1_000)
    expect(result.kind).toBe('confirmed')
    expect(result.summary).toBe('已同步到云端，本机草稿状态暂未确认')
    expect(result.details.join('')).toContain('同步进度')
    expect(result.announcementKey).toContain('metadata:confirm:unavailable')
    const newer = localSaveIndicator({ ...LOCAL, coversCurrent: false, draft }, ONLINE, 1_000)
    expect(newer.kind).toBe('partial')
    expect(newer.summary).toBe('较早的修改已同步到云端，最新输入仍在本页')
    expect(newer.summary).not.toContain('已落盘')
  })

  it.each(['quota', 'unavailable', 'no-key'] as const)('同步元数据 %s 未落盘时，保留正文的本机确认但明确限制与播报', (reason) => {
    if (LOCAL.draft.kind !== 'working')
      throw new Error('夹具必须有草稿')
    const draft = { ...LOCAL.draft, metadataIssue: { operation: 'mark' as const, reason } }
    const result = localSaveIndicator({ ...LOCAL, draft }, ONLINE, 1_000)
    expect(result.summary).toBe('已保存在本机（等待同步）')
    expect(result.details.join('')).toContain('同步进度')
    expect(result.details.join('')).toContain('另存为副本')
    expect(result.announcementKey).toContain(`metadata:mark:${reason}`)
    expect(result.announcement).toContain('同步进度')
    expect(result.details.join('')).not.toContain('尚未落盘的修改只在当前页面')
  })

  it('只有当前修改完整落盘才显示指定的本机保存文案，云端仍未同步', () => {
    expect(localSaveIndicator(LOCAL, ONLINE, 1_000)).toMatchObject({ kind: 'saved', summary: '已保存在本机（等待同步）' })
    expect(localSaveIndicator(LOCAL, OFFLINE, 1_000)).toMatchObject({ kind: 'saved', summary: '已离线，修改已保存在本机' })
    expect(localSaveIndicator({ ...LOCAL, coversCurrent: false }, OFFLINE, 1_000)).toMatchObject({ kind: 'partial' })
    expect(localSaveIndicator({ ...LOCAL, coversCurrent: false }, OFFLINE, 1_000).summary).toContain('最新输入仍在本页')
  })

  it.each(['writing', 'confirmed'] as const)('%s 都不能被说成当前仍有本机记录', (kind) => {
    if (LOCAL.draft.kind !== 'working')
      throw new Error('夹具必须有草稿')
    const indicator = localSaveIndicator({ ...LOCAL, draft: { ...LOCAL.draft, local: kind === 'writing' ? { kind } : { kind, revision: 2 } } }, ONLINE, 1_000)
    expect(indicator.kind).toBe(kind)
    expect(indicator.summary).not.toContain('已保存在本机')
    if (kind === 'confirmed')
      expect(indicator.summary).toContain('本机草稿已清除')
  })

  it('部署关闭立即说明真实限制；云端已确认也不能掩盖后续本机保护关闭', () => {
    expect(localSaveIndicator({ ...LOCAL, enabled: false, unsaved: false }, ONLINE, 1_000).summary).toBe('本部署关闭了本机草稿（浏览器崩溃会丢掉没保存的修改）')
  })

  it('部署后来开启，本轮仍用内存时说明如何在下一轮启用，不能说部署仍关闭', () => {
    const result = localSaveIndicator({ ...LOCAL, storage: { ...LOCAL.storage, kind: 'memory', reason: 'disabled' } }, ONLINE, 1_000)
    expect(result.summary).toContain('本轮编辑尚未启用')
    expect(result.summary).not.toContain('本部署关闭')
  })

  it.each([
    ['quota', '本机存储空间不足'],
    ['no-key', '密钥'],
    ['unsupported', '不支持'],
    ['unavailable', '存储不可用'],
    ['existing-draft', '已有草稿'],
    ['worker-failed', '后台保存'],
    ['fenced', '写入资格'],
    ['paused', '已暂停'],
  ] satisfies [DraftMemoryReason, string][])('内存退路 %s 不冒充已落盘，说明具体原因', (reason, phrase) => {
    const indicator = localSaveIndicator({ ...LOCAL, storage: { ...LOCAL.storage, kind: 'memory', reason } }, ONLINE, 1_000)
    expect(indicator).toMatchObject({ kind: 'memory' })
    expect(indicator.summary).toContain(phrase)
    expect(indicator.summary).not.toContain('已保存在本机')
    expect(indicator.announcementKey).toBeDefined()
  })

  it('实际请求无回应单独说明，不凭在线信号声称成功；异常起点跨重连保留 90 秒提示', () => {
    const unavailable = { ...OFFLINE, browserOnline: true, problem: 'unresponsive' } as const
    const before = localSaveIndicator({ ...LOCAL, coversCurrent: false }, unavailable, 90_999)
    expect(before.details).toContain('网络没有回应，正在重试')
    expect(before.details.join('')).not.toContain('编辑权可能已过期')
    const after = localSaveIndicator(LOCAL, unavailable, 91_000)
    expect(after.details.join('')).toContain('编辑权可能已过期')
    expect(after.details.join('')).toContain('另存为副本')
    expect(after.announcementKey).not.toBe(before.announcementKey)
    expect(localSaveIndicator(LOCAL, ONLINE, 100_000).details.join('')).not.toContain('编辑权可能已过期')
  })

  it.each(['busy', 'quota', 'unsupported', 'newer-format', 'failed'] as const)('额外备份 %s 降级不否认已经完成的本机写入，也不隐藏限制', (reason) => {
    const mirror = reason === 'failed' ? { kind: 'not-mirrored', reason, error: { name: 'Error', message: '不可用' } } as const : { kind: 'not-mirrored', reason } as const
    const result = localSaveIndicator({ ...LOCAL, storage: { ...LOCAL.storage, mirror } }, ONLINE, 1_000)
    expect(result.summary).toBe('已保存在本机（等待同步）')
    expect(result.details.join('')).toContain('额外备份')
    expect(result.announcementKey).toBeDefined()
  })

  it.each(['denied', 'unsupported', 'failed'] as const)('持久保存申请 %s 不影响已落盘事实，也不承诺永久保留', (kind) => {
    const persistence = kind === 'failed' ? { kind, error: { name: 'Error', message: '不可用' } } : { kind }
    const result = localSaveIndicator({ ...LOCAL, storage: { ...LOCAL.storage, persistence, hostKind: 'in-process' } }, ONLINE, 1_000)
    expect(result.summary).toBe('已保存在本机（等待同步）')
    expect(result.details.join('')).toContain('浏览器仍可能清理')
    expect(result.details.join('')).toContain('由本页处理')
  })

  it('正常写入和序号变化没有故障播报键；离线键不随每次输入与落盘改变', () => {
    const partial = { ...LOCAL, coversCurrent: false }
    expect(localSaveIndicator(LOCAL, ONLINE, 1_000).announcementKey).toBeUndefined()
    expect(localSaveIndicator(partial, ONLINE, 1_000).announcementKey).toBeUndefined()
    expect(localSaveIndicator(LOCAL, OFFLINE, 1_000).announcementKey).toBe(localSaveIndicator(partial, OFFLINE, 2_000).announcementKey)
  })
})
