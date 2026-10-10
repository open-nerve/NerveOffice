import type { LeaseVerdict } from './edit-lease.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gunzipBytes } from '../../shared/outbox/draft-codec.ts'
import { deferred, disposeSessions, DOCUMENT, editorFixture, fixture, INITIAL, leaseFixture, localDrafts, prepare, SAVED, USER } from './editing-session.test-support.ts'
import { settle } from './fake-lease-clock.test-support.ts'

afterEach(disposeSessions)

describe('本机状态跟随当前编辑和输入', () => {
  it('A 落盘晚于 B 的编辑不能覆盖 B；输入未提交时也不能声称全部已落盘', async () => {
    const local = await localDrafts()
    const { session, options } = fixture({ localDrafts: local.options })
    const page = editorFixture()
    await prepare(session)
    session.startSaving(page.editor, INITIAL)
    session.stopCapturing()
    page.edit()
    const writing = local.store.holdNext('writeDraft')
    const a = session.draft!.capture({ editorSeq: 1, snapshot: 'A', formulasPending: false, dedupe: false })
    await writing.reached
    try {
      vi.mocked(options.onChange).mockClear()
      page.edit()
      expect(options.onChange).toHaveBeenCalled()
    }
    finally {
      writing.release()
      await session.draft!.ready(a)
    }
    expect(session.localSave()).toMatchObject({ draft: { local: { kind: 'persisted' }, ref: { editorSeq: 1 } }, coversCurrent: false, unsaved: true })
    const b = session.draft!.capture({ editorSeq: 2, snapshot: 'B', formulasPending: false, dedupe: false })
    await session.draft!.ready(b)
    const saved = session.localSave()
    expect(saved).toMatchObject({ coversCurrent: true })
    expect(session.localSave()).toBe(saved)
    vi.mocked(options.onChange).mockClear()
    page.setInput('pending')
    expect(options.onChange).toHaveBeenCalled()
    expect(session.localSave()).toMatchObject({ coversCurrent: false })
    page.setInput('none')
    expect(session.localSave()).toMatchObject({ coversCurrent: true })
  })

  it('来源转交后不再通知旧会话；新所有者仍可订阅存储和内容，旧会话销毁不影响它', async () => {
    const local = await localDrafts()
    const { session, options } = fixture({ localDrafts: local.options })
    const page = editorFixture()
    await prepare(session)
    session.startSaving(page.editor, INITIAL)
    session.stopCapturing()
    session.coordinator!.dispose()
    const draft = session.takeDraft()!
    session.stopSaving()
    session.dispose()
    expect(session.localSave()).toBeUndefined()
    vi.mocked(options.onChange).mockClear()
    const changed = vi.fn()
    const stop = draft.subscribe(changed)
    const ref = draft.capture({ editorSeq: 1, snapshot: '转交后', formulasPending: false, dedupe: false })
    await draft.ready(ref)
    expect(changed).toHaveBeenCalled()
    expect(options.onChange).not.toHaveBeenCalled()
    expect(page.listeners()).toBe(0)
    stop()
    draft.dispose()
  })
})

describe('草稿恢复沿用租约的失效与续上规则', () => {
  it('续上后新核对再次失效时结束本轮恢复，不循环申请也不绕过租约通知失效', async () => {
    const local = await localDrafts()
    const { session, options } = fixture({ localDrafts: local.options })
    const held = leaseFixture()
    await prepare(session, held)
    held.confirm.mockResolvedValue({ kind: 'ended', loss: { kind: 'lease', reason: 'expired' } })
    session.suspendDraft()
    await session.resumeDraft()
    expect(held.lose).toHaveBeenCalledOnce()
    expect(held.confirm).toHaveBeenCalledTimes(2)
    expect(options.onLost).not.toHaveBeenCalled()
    expect(local.host).toHaveBeenCalledOnce()
  })

  it.each(['expired', 'session'] as const)('恢复核对 %s 先交租约续上，随后必须另核对 current 才恢复写入', async (reason) => {
    const local = await localDrafts()
    const { session, options } = fixture({ localDrafts: local.options })
    const held = leaseFixture()
    await prepare(session, held)
    const recheck = deferred<LeaseVerdict>()
    const loss = { kind: 'lease' as const, reason }
    held.confirm.mockResolvedValueOnce({ kind: 'ended', loss }).mockReturnValueOnce(recheck.promise)
    session.suspendDraft()
    const resuming = session.resumeDraft()
    await vi.waitFor(() => expect(held.lose).toHaveBeenCalledExactlyOnceWith(loss, held.credentials()))
    expect(held.confirm).toHaveBeenCalledTimes(2)
    expect(local.host).toHaveBeenCalledOnce()
    expect(options.onLost).not.toHaveBeenCalled()
    recheck.resolve({ kind: 'current' })
    await resuming
    const draft = session.draft!
    const ref = draft.capture({ editorSeq: 1, snapshot: '续上后的正文', formulasPending: false, dedupe: false })
    expect(await draft.ready(ref)).toMatchObject({ kind: 'ready', local: { kind: 'persisted' } })
    expect(options.onLost).not.toHaveBeenCalled()
  })

  it('初次登记遇栅栏且本代到期时也走续上，不直接放弃仍可恢复的租约', async () => {
    const local = await localDrafts()
    const { session, options } = fixture({ localDrafts: local.options })
    const held = leaseFixture()
    local.store.putRaw('writers', { userId: USER.id, documentId: DOCUMENT }, { userId: USER.id, documentId: DOCUMENT, writeEpoch: 8, writerId: 'other', lastDraftSeq: 0, registeredAt: 1 })
    held.confirm.mockResolvedValueOnce({ kind: 'ended', loss: { kind: 'lease', reason: 'expired' } })
    expect(await prepare(session, held)).toMatchObject({ kind: 'ready' })
    expect(held.lose).toHaveBeenCalledOnce()
    expect(held.confirm).toHaveBeenCalledTimes(2)
    expect(options.onLost).not.toHaveBeenCalled()
  })

  it('核对期间换人，旧 ended 回包不能续上或通知新流程', async () => {
    const local = await localDrafts()
    let active = true
    const { session, options } = fixture({ localDrafts: local.options, sessionActive: () => active })
    const held = leaseFixture()
    await prepare(session, held)
    const checking = deferred<LeaseVerdict>()
    held.confirm.mockReturnValueOnce(checking.promise)
    session.suspendDraft()
    const resuming = session.resumeDraft()
    await vi.waitFor(() => expect(held.confirm).toHaveBeenCalledOnce())
    active = false
    session.discardDraftKey()
    active = true
    checking.resolve({ kind: 'ended', loss: { kind: 'lease', reason: 'expired' } })
    await resuming
    expect(held.lose).not.toHaveBeenCalled()
    expect(options.onLost).not.toHaveBeenCalled()
  })
})

describe('编辑会话的资源所有权', () => {
  it('退出清钥前同步捕获编辑器的当前内容，不依赖自动捕获是否已经到点', async () => {
    const { session } = fixture()
    const page = editorFixture()
    await prepare(session)
    session.startSaving(page.editor, INITIAL)
    page.edit()
    session.discardDraftKey()
    expect(await session.draft!.readLatest()).toMatchObject({ snapshot: '{"v":1}', ref: { editorSeq: 1 } })
  })

  it('没有租约、本机锁或就绪来源时不能建保存；来源准备完成才接上捕获', async () => {
    const { session } = fixture()
    const page = editorFixture()
    await expect(session.prepareDraft(INITIAL)).rejects.toThrow('租约')
    session.acceptLease(leaseFixture(), 3)
    await expect(session.prepareDraft(INITIAL)).rejects.toThrow('本机锁')
    expect(() => session.startSaving(page.editor, INITIAL)).toThrow('来源')
    expect(session.autosave).toBeUndefined()
    expect(page.listeners()).toBe(0)
    await session.claim(session.lease!)
    expect(await session.prepareDraft(INITIAL)).toMatchObject({ kind: 'ready' })
    session.startSaving(page.editor, INITIAL)
    expect(page.listeners()).toBeGreaterThan(0)
  })

  it('来源唯一转交后原会话停止/销毁不再碰它；接收者可读并负责销毁', async () => {
    const { session } = fixture()
    await prepare(session)
    const source = session.draft!
    const ref = source.capture({ snapshot: '待转交的内容', editorSeq: 1, formulasPending: false, dedupe: true })
    await source.ready(ref)
    expect(session.takeDraft()).toBe(source)
    expect(session.takeDraft()).toBeUndefined()
    expect(session.draft).toBeUndefined()
    session.stopSaving()
    session.dispose()
    expect(await source.readLatest()).toMatchObject({ ref, snapshot: '待转交的内容' })
    source.dispose()
    expect(source.view()).toEqual({ kind: 'disposed' })
  })

  it('申请与接纳分开：准备阶段的基准进入租约，销毁释放实际持有的那一代', async () => {
    const { session } = fixture()
    session.setBaseRevision(3)
    const acquired = await session.acquire()
    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired')
      throw new Error('没有取得租约')
    expect(session.lease).toBeUndefined()
    session.acceptLease(acquired.lease, acquired.revision)
    expect(await session.claim(acquired.lease)).toEqual({ kind: 'held' })
    expect(session.holdsLock()).toBe(true)
    session.releaseLease()
    expect(session.lease).toBeUndefined()
    expect(session.holdsLock()).toBe(false)
  })

  it('观察者 attach 时协调器与调度都已可读；重复停止会清净订阅且只分离一次', async () => {
    const { session, options, pageListeners, attach } = fixture()
    const page = editorFixture()
    await prepare(session)
    attach.mockImplementation((scheduler) => {
      if (scheduler !== undefined) {
        expect(session.coordinator).toBeDefined()
        expect(session.autosave).toBe(scheduler)
      }
    })
    session.startSaving(page.editor, INITIAL)
    expect(page.listeners()).toBeGreaterThan(0)
    expect(pageListeners.size).toBe(1)
    session.stopSaving()
    session.stopSaving()
    expect(page.listeners()).toBe(0)
    expect(pageListeners.size).toBe(0)
    expect(session.coordinator).toBeUndefined()
    expect(session.autosave).toBeUndefined()
    expect(options.autosave.attach).toHaveBeenCalledTimes(2)
    const notifications = vi.mocked(options.onChange).mock.calls.length
    page.edit()
    expect(options.onChange).toHaveBeenCalledTimes(notifications)
  })

  it('停捕获不销毁在途保存：回执仍确认原请求并推进基准', async () => {
    const { session, options } = fixture()
    const page = editorFixture()
    const pending = deferred<typeof SAVED>()
    vi.mocked(options.api.save).mockReturnValue(pending.promise)
    await prepare(session)
    session.startSaving(page.editor, INITIAL)
    page.edit()
    const saving = session.coordinator
    if (saving === undefined)
      throw new Error('保存协调未建立')
    const draft = session.draft
    if (draft === undefined)
      throw new Error('工作草稿未建立')
    const ref = draft.capture({ editorSeq: 1, snapshot: '{"v":1}', formulasPending: false, dedupe: false })
    const outcome = saving.save(() => ref, { dedupe: false })
    await vi.waitFor(() => expect(options.api.save).toHaveBeenCalledTimes(1))
    session.stopCapturing()
    expect(session.coordinator).toBe(saving)
    expect(session.autosave).toBeUndefined()
    pending.resolve(SAVED)
    expect(await outcome).toEqual({ kind: 'saved', requestId: 'request-1' })
    expect(session.baseRevision()).toBe(4)
  })

  it('已失效的租约只忘记，不误发释放；本机锁单独交还', async () => {
    const { session } = fixture()
    const held = leaseFixture()
    session.acceptLease(held, 3)
    await session.claim(held)
    session.detachLease()
    expect(session.lease).toBeUndefined()
    expect(held.release).not.toHaveBeenCalled()
    expect(session.holdsLock()).toBe(true)
    session.releaseLock()
    expect(session.holdsLock()).toBe(false)
    session.dispose()
    expect(held.release).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'current' },
    { kind: 'superseded', loss: { kind: 'taken-over', where: 'elsewhere' } },
  ] satisfies LeaseVerdict[])('旧会话的 $kind 核对晚于重新进入：新租约、锁和保存继续有效', async (verdict) => {
    const { session, options, other, pageListeners, attach } = fixture()
    const previous = leaseFixture()
    const previousPage = editorFixture()
    const pending = deferred<LeaseVerdict>()
    previous.confirm.mockReturnValue(pending.promise)
    session.acceptLease(previous, 3)
    expect(await session.claim(previous)).toEqual({ kind: 'held' })
    await session.prepareDraft(INITIAL)
    session.startSaving(previousPage.editor, INITIAL)

    const occupied = await other.steal()
    await settle()
    expect(previous.confirm).toHaveBeenCalledTimes(1)
    session.releaseLease()
    session.stopSaving()
    occupied.release()
    await settle()
    expect(previousPage.listeners()).toBe(0)

    const next = { ...leaseFixture(), credentials: () => ({ token: 'token-2', writeEpoch: 8 }) }
    next.confirm.mockResolvedValue({ kind: 'unknown', error: undefined })
    const nextPage = editorFixture()
    session.acceptLease(next, 9)
    expect(await session.claim(next)).toEqual({ kind: 'held' })
    await session.prepareDraft({ revision: 9 })
    session.startSaving(nextPage.editor, { ...INITIAL, revision: 9 })
    const saving = session.coordinator
    const scheduler = session.autosave
    if (saving === undefined || scheduler === undefined)
      throw new Error('新会话的保存未建立')

    pending.resolve(verdict)
    await settle()
    expect(session.lease).toBe(next)
    expect(session.coordinator).toBe(saving)
    expect(session.autosave).toBe(scheduler)
    expect(session.holdsLock()).toBe(true)
    expect(options.onLost).not.toHaveBeenCalled()
    expect(previous.abandon).not.toHaveBeenCalled()
    expect(next.abandon).not.toHaveBeenCalled()
    expect(next.release).not.toHaveBeenCalled()
    expect(next.confirm).not.toHaveBeenCalled()
    expect(nextPage.listeners()).toBeGreaterThan(0)
    expect(pageListeners.size).toBe(1)

    vi.mocked(options.api.save).mockResolvedValue({ ...SAVED, revision: 10 })
    nextPage.edit()
    expect(await scheduler.flush('save-button')).toEqual({
      edits: true,
      formulas: true,
      outcome: { kind: 'saved', requestId: 'request-1' },
    })
    expect(options.api.save).toHaveBeenCalledTimes(1)
    expect(options.api.save).toHaveBeenCalledWith(DOCUMENT, expect.objectContaining({ baseRevision: 9 }), expect.any(Uint8Array), next.credentials())
    const body = vi.mocked(options.api.save).mock.calls[0]![2]
    expect(new TextDecoder().decode(await gunzipBytes(body))).toBe('{"v":1}')
    expect(session.baseRevision()).toBe(10)

    session.stopSaving()
    session.stopSaving()
    session.dispose()
    session.dispose()
    expect(previous.release).toHaveBeenCalledTimes(1)
    expect(next.release).toHaveBeenCalledTimes(1)
    expect(nextPage.listeners()).toBe(0)
    expect(pageListeners.size).toBe(0)
    expect(attach.mock.calls.filter(([scheduler]) => scheduler === undefined)).toHaveLength(2)
  })

  it('销毁期间晚到的核对不能抢锁或通知新的失效', async () => {
    const { session, options, other } = fixture()
    const occupied = await other.tryHold()
    const held = leaseFixture()
    const pending = deferred<LeaseVerdict>()
    held.confirm.mockReturnValue(pending.promise)
    session.acceptLease(held, 3)
    const claiming = session.claim(held)
    await settle()
    expect(held.confirm).toHaveBeenCalledTimes(1)
    session.dispose()
    pending.resolve({ kind: 'superseded', loss: { kind: 'taken-over', where: 'elsewhere' } })
    expect(await claiming).toEqual({ kind: 'released' })
    expect(options.onLost).not.toHaveBeenCalled()
    expect(session.holdsLock()).toBe(false)
    expect(held.release).toHaveBeenCalledTimes(1)
    occupied?.release()
  })
})
