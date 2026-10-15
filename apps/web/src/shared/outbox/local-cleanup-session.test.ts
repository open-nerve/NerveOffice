import type { LocalCleanupOptions, MetadataCleanupOutcome } from './local-cleanup.ts'
import type { DraftSessionPermit, UserCleanupPermit } from './session-fence.ts'
import type { SessionStore } from './session-store.ts'
import { describe, expect, it, vi } from 'vitest'
import { DOCUMENT_ID, NOW, sampleStoredDraft, USER_ID } from './draft-record.test-support.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createLocalCleanup } from './local-cleanup.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { deferred } from './outbox-lock.test-support.ts'
import { withOutboxLock } from './outbox-lock.ts'
import { testSessionPermit } from './session-fence.test-support.ts'

const KEY = { userId: USER_ID, documentId: DOCUMENT_ID }
const PERMIT: UserCleanupPermit = { ...testSessionPermit(), cause: 'logout' }

function setup(clearMetadata?: LocalCleanupOptions['clearMetadata']) {
  const store = fakeDraftStore()
  const files = fakeMirrorDirectory()
  const sessions = {
    beginUserCleanup: vi.fn(async () => ({ kind: 'clearing' as const, permit: PERMIT })),
    finishUserCleanup: vi.fn<SessionStore['finishUserCleanup']>(async () => ({ kind: 'cleared' })),
  }
  const retire = vi.fn(store.store.retireUser)
  const cleanup = createLocalCleanup({ store: { ...store.store, retireUser: retire }, sessions, directory: files.directory, now: () => NOW, ...(clearMetadata === undefined ? {} : { clearMetadata }) })
  return { store, files, sessions, retire, cleanup }
}

describe('清理资格的完整操作边界', () => {
  it('没有完整清理许可时不接触原件或镜像，不能再只传 userId', async () => {
    const { store, cleanup, sessions } = setup()
    store.putRaw('drafts', KEY, sampleStoredDraft())
    const original = store.rawDraft(KEY)
    expect(await cleanup.removeUser(USER_ID as unknown as UserCleanupPermit)).toEqual({ kind: 'invalidated' })
    expect(store.rawDraft(KEY)).toEqual(original)
    expect(store.calls).toEqual([])
    expect(sessions.finishUserCleanup).not.toHaveBeenCalled()
  })

  it('开始清理先在同源锁内持久化 clearing，捕获调用时的 active 许可', async () => {
    const { cleanup, sessions } = setup()
    const active = { ...testSessionPermit() }
    const held = deferred<void>()
    const entered = deferred<void>()
    const blocking = withOutboxLock(async () => {
      entered.resolve()
      await held.promise
    })
    await entered.promise
    let starting
    try {
      starting = cleanup.beginUser(active, 'logout')
      active.generation = crypto.randomUUID()
      expect(sessions.beginUserCleanup).not.toHaveBeenCalled()
    }
    finally {
      held.resolve()
      await blocking
    }
    expect(await starting).toEqual({ kind: 'clearing', permit: PERMIT })
    expect(sessions.beginUserCleanup).toHaveBeenCalledWith(testSessionPermit(), 'logout')
  })

  it('旧清理在检查阶段失效时不碰镜像，交回 invalidated', async () => {
    const { store, files, cleanup, sessions } = setup()
    store.failNext('retireUser', { kind: 'session-invalid' })
    files.putFile(KEY, 0, new Uint8Array([1]))
    expect(await cleanup.removeUser(PERMIT)).toEqual({ kind: 'invalidated' })
    expect((await files.directory.slotFiles(KEY)).kind).toBe('files')
    expect(sessions.finishUserCleanup).not.toHaveBeenCalled()
  })

  it('镜像忙只交回 pending，不将 clearing 改成 cleared', async () => {
    const { store, files, cleanup, sessions } = setup()
    store.putRaw('drafts', KEY, sampleStoredDraft())
    const original = store.rawDraft(KEY)
    files.putFile(KEY, 0, new Uint8Array([1]))
    files.holdElsewhere(KEY)
    expect(await cleanup.removeUser(PERMIT)).toEqual({ kind: 'pending', pending: [KEY] })
    expect(store.rawDraft(KEY)).toEqual(original)
    expect(sessions.finishUserCleanup).not.toHaveBeenCalled()
  })

  it('完成清理必须提交 cleared，调用后的许可变化不能替换本轮资格', async () => {
    const { cleanup, sessions, retire } = setup()
    const permit = { ...PERMIT }
    const clearing = cleanup.removeUser(permit)
    permit.generation = crypto.randomUUID()
    expect(await clearing).toEqual({ kind: 'cleared', pending: [] })
    expect(retire).toHaveBeenCalledWith(PERMIT, { now: NOW })
    expect(sessions.finishUserCleanup).toHaveBeenCalledWith(PERMIT)
  })

  it('开始的资格无效时不尝试建立清理状态', async () => {
    const { cleanup, sessions } = setup()
    expect(await cleanup.beginUser({ userId: USER_ID } as DraftSessionPermit, 'logout')).toEqual({ kind: 'session-invalid' })
    expect(sessions.beginUserCleanup).not.toHaveBeenCalled()
  })

  it('最终状态提交失败不能声称已完成；换代失败转换为 invalidated', async () => {
    const { cleanup, sessions } = setup()
    sessions.finishUserCleanup.mockResolvedValueOnce({ kind: 'quota' })
    expect(await cleanup.removeUser(PERMIT)).toEqual({ kind: 'quota' })
    sessions.finishUserCleanup.mockResolvedValueOnce({ kind: 'session-invalid' })
    expect(await cleanup.removeUser(PERMIT)).toEqual({ kind: 'invalidated' })
    expect(await cleanup.removeUser(PERMIT)).toEqual({ kind: 'cleared', pending: [] })
  })
})

describe('完整清单在原清理许可内完成', () => {
  it.each(['pending', 'failed', 'throw'] as const)('附加清单 %s 仍清理草稿，但不完成 clearing；同许可重试才能结束', async (kind) => {
    let result: MetadataCleanupOutcome = kind === 'pending' ? { kind: 'pending' } : { kind: 'failed', error: new Error('storage') }
    let throws = kind === 'throw'
    const t = setup(async () => {
      if (throws)
        throw new Error('storage')
      return result
    })
    t.store.putRaw('drafts', KEY, sampleStoredDraft())
    t.files.putFile(KEY, 0, new Uint8Array([1]))
    expect(await t.cleanup.removeUser(PERMIT)).toMatchObject({ kind: kind === 'pending' ? 'pending' : 'failed' })
    expect(t.store.rawDraft(KEY)).toBeUndefined()
    expect(await t.files.directory.listDocuments(USER_ID)).toEqual({ kind: 'listed', documentIds: [] })
    expect(t.sessions.finishUserCleanup).not.toHaveBeenCalled()
    result = { kind: 'cleared' }
    throws = false
    expect(await t.cleanup.removeUser(PERMIT)).toEqual({ kind: 'cleared', pending: [] })
    expect(t.sessions.finishUserCleanup).toHaveBeenCalledExactlyOnceWith(PERMIT)
  })

  it('已换代的旧重试不碰同用户的新记号；有效原许可会清本人并保留其他账户', async () => {
    const keys = new Map([[USER_ID, 'new-session'], ['another-user', 'other']])
    const t = setup(async (userId) => {
      keys.delete(userId)
      return { kind: 'cleared' }
    })
    t.store.failNext('retireUser', { kind: 'session-invalid' })
    expect(await t.cleanup.removeUser(PERMIT)).toEqual({ kind: 'invalidated' })
    expect([...keys]).toEqual([[USER_ID, 'new-session'], ['another-user', 'other']])
    expect(await t.cleanup.removeUser(PERMIT)).toEqual({ kind: 'cleared', pending: [] })
    expect([...keys]).toEqual([['another-user', 'other']])
  })

  it('镜像仍忙也执行附加清单，不能把旧记号留到镜像不忙才清', async () => {
    let metadata = 'old'
    const t = setup(async () => {
      metadata = ''
      return { kind: 'cleared' }
    })
    t.files.putFile(KEY, 0, new Uint8Array([1]))
    t.files.holdElsewhere(KEY)
    expect(await t.cleanup.removeUser(PERMIT)).toEqual({ kind: 'pending', pending: [KEY] })
    expect(metadata).toBe('')
    expect(t.sessions.finishUserCleanup).not.toHaveBeenCalled()
  })

  it('附加清理尚未结束时新登录的互斥任务不能越过它，完成后才激活', async () => {
    const entered = deferred<void>()
    const release = deferred<MetadataCleanupOutcome>()
    const t = setup(async () => {
      entered.resolve()
      return release.promise
    })
    const cleaning = t.cleanup.removeUser(PERMIT)
    await entered.promise
    let activated = false
    const activate = withOutboxLock(async () => {
      activated = true
    })
    await Promise.resolve()
    expect(activated).toBe(false)
    release.resolve({ kind: 'cleared' })
    expect(await cleaning).toEqual({ kind: 'cleared', pending: [] })
    await activate
    expect(activated).toBe(true)
  })
})
