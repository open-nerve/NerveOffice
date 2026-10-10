import type { RenewedEditLease } from '@nerve-office/contracts'
import type { LeaseVerdict } from './edit-lease.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { createConnectionState } from '../../shared/lib/connection-state.ts'
import { gunzipBytes } from '../../shared/outbox/draft-codec.ts'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { disposeSessions, DOCUMENT, editorFixture, fixture, INITIAL, leaseFixture, localDrafts, prepare } from './editing-session.test-support.ts'
import { settle } from './fake-lease-clock.test-support.ts'

afterEach(disposeSessions)

async function connected(persistent = false) {
  const connection = createConnectionState({ online: true, now: Date.now })
  const local = persistent ? await localDrafts() : undefined
  let active = true
  const context = fixture({
    connection,
    sessionActive: () => active,
    localDrafts: local?.options,
    autosave: {
      page: {
        visible: () => true,
        online: () => connection.view().browserOnline,
        sessionWritable: () => active,
        onChange: connection.subscribe,
      },
    },
  })
  const held = leaseFixture()
  const page = editorFixture()
  await prepare(context.session, held)
  context.session.startSaving(page.editor, INITIAL)
  // 这些交错直接控制上传；自动捕获另有断网用例验证。
  const capture = () => context.session.draft!.capture({ editorSeq: page.editor.changeSeq(), snapshot: page.editor.capture(), formulasPending: false, dedupe: false })
  const save = async () => context.session.coordinator!.save(capture, { dedupe: false })
  return { ...context, connection, local, held, page, save, setActive: (next: boolean) => {
    active = next
  } }
}

describe('重连必须重新确认当前编辑权', () => {
  it('断网仍自动捕获并落盘，online 与成功请求都不能替代租约确认', async () => {
    const t = await connected(true)
    const checking = deferred<LeaseVerdict>()
    t.held.confirm.mockReturnValue(checking.promise)
    t.connection.setBrowserOnline(false)
    t.page.edit()
    await t.time.advance(2_000)
    await vi.waitFor(() => expect(t.session.draft!.view()).toMatchObject({ kind: 'working', ref: { editorSeq: 1 }, local: { kind: 'persisted' } }))
    expect(t.options.api.save).not.toHaveBeenCalled()
    expect(t.local!.host).toHaveBeenCalledOnce()
    expect(t.held.confirm).not.toHaveBeenCalled()

    t.connection.setBrowserOnline(true)
    await vi.waitFor(() => expect(t.held.confirm).toHaveBeenCalledOnce())
    t.connection.succeeded(t.connection.beginRequest())
    expect(await t.save()).toMatchObject({ kind: 'skipped', reason: 'stopped' })
    expect(t.options.api.save).not.toHaveBeenCalled()
    checking.resolve({ kind: 'current' })
    await settle()
    expect(await t.save()).toMatchObject({ kind: 'saved' })
    expect(t.local!.host).toHaveBeenCalledOnce()
    const body = vi.mocked(t.options.api.save).mock.calls[0]![2]
    expect(new TextDecoder().decode(await gunzipBytes(body))).toBe('{"v":1}')
  })

  it('租约已过期时只续上一轮，并在新一轮 current 之前保持零上传', async () => {
    const t = await connected()
    t.session.stopCapturing()
    const checking = deferred<LeaseVerdict>()
    const loss = { kind: 'lease', reason: 'expired' } as const
    t.held.confirm.mockResolvedValueOnce({ kind: 'ended', loss }).mockReturnValueOnce(checking.promise)
    t.connection.setBrowserOnline(false)
    t.page.edit()
    t.connection.setBrowserOnline(true)
    await vi.waitFor(() => expect(t.held.confirm).toHaveBeenCalledTimes(2))
    expect(t.held.lose).toHaveBeenCalledExactlyOnceWith(loss, t.held.credentials())
    expect(await t.save()).toMatchObject({ kind: 'skipped' })
    expect(t.options.api.save).not.toHaveBeenCalled()
    checking.resolve({ kind: 'current' })
    await settle()
    expect(await t.save()).toMatchObject({ kind: 'saved' })
  })

  it('别人已取得编辑权时沿原失效回调收尾，不申请或上传', async () => {
    const t = await connected()
    t.session.stopCapturing()
    const loss = { kind: 'taken-over', where: 'elsewhere' } as const
    t.held.confirm.mockResolvedValue({ kind: 'superseded', loss })
    t.connection.setBrowserOnline(false)
    t.page.edit()
    t.connection.setBrowserOnline(true)
    await vi.waitFor(() => expect(t.options.onLost).toHaveBeenCalledExactlyOnceWith(loss))
    await t.time.advance(60_000)
    expect(t.held.confirm).toHaveBeenCalledOnce()
    expect(t.held.abandon).toHaveBeenCalledOnce()
    expect(t.held.lose).not.toHaveBeenCalled()
    expect(await t.save()).toMatchObject({ kind: 'skipped' })
    expect(t.options.api.save).not.toHaveBeenCalled()
  })

  it('同轮触发合并，未知确认按 2、4、8、16、30 秒退避；成功请求不清等待', async () => {
    const t = await connected()
    t.session.stopCapturing()
    t.held.confirm.mockResolvedValue({ kind: 'unknown', error: undefined })
    t.connection.setBrowserOnline(false)
    t.connection.setBrowserOnline(true)
    await settle()
    let calls = 1
    expect(t.held.confirm).toHaveBeenCalledTimes(calls)
    for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      t.connection.succeeded(t.connection.beginRequest())
      t.connection.setBrowserOnline(true)
      await t.time.advance(delay - 1)
      expect(t.held.confirm).toHaveBeenCalledTimes(calls)
      await t.time.advance(1)
      expect(t.held.confirm).toHaveBeenCalledTimes(++calls)
    }
    t.connection.setBrowserOnline(false)
    await t.time.advance(60_000)
    expect(t.held.confirm).toHaveBeenCalledTimes(calls)
  })

  it.each(['current', 'ended'] as const)('再次断网使在途 %s 过时；重连等待旧核对结束再发新核对', async (kind) => {
    const t = await connected()
    t.session.stopCapturing()
    const old = deferred<LeaseVerdict>()
    const fresh = deferred<LeaseVerdict>()
    t.held.confirm.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    t.connection.setBrowserOnline(false)
    t.connection.setBrowserOnline(true)
    await settle()
    t.connection.setBrowserOnline(false)
    t.connection.setBrowserOnline(true)
    t.connection.succeeded(t.connection.beginRequest())
    expect(t.held.confirm).toHaveBeenCalledOnce()
    old.resolve(kind === 'current' ? { kind } : { kind, loss: { kind: 'lease', reason: 'expired' } })
    await vi.waitFor(() => expect(t.held.confirm).toHaveBeenCalledTimes(2))
    t.page.edit()
    expect(await t.save()).toMatchObject({ kind: 'skipped' })
    expect(t.held.lose).not.toHaveBeenCalled()
    fresh.resolve({ kind: 'current' })
    await settle()
    expect(await t.save()).toMatchObject({ kind: 'saved' })
  })

  it.each(['user', 'lease', 'lock', 'dispose'] as const)('%s 已变使旧确认失效，不能重新放开旧协调器或留下计时器', async (change) => {
    const t = await connected()
    t.session.stopCapturing()
    const checking = deferred<LeaseVerdict>()
    t.held.confirm.mockReturnValue(checking.promise)
    t.connection.setBrowserOnline(false)
    t.connection.setBrowserOnline(true)
    await settle()
    t.page.edit()
    const saver = t.session.coordinator!
    const draft = t.session.draft!
    if (change === 'user') {
      t.setActive(false)
      t.session.setSavingActive(false)
    }
    else if (change === 'lease') {
      t.session.acceptLease(leaseFixture(), 3)
    }
    else if (change === 'lock') {
      t.session.releaseLock()
    }
    else {
      t.session.dispose()
    }
    checking.resolve({ kind: 'current' })
    await t.time.advance(60_000)
    expect(await saver.save(() => draft.capture({ editorSeq: 1, snapshot: '旧内容', formulasPending: false, dedupe: false }), { dedupe: false })).toMatchObject({ kind: 'skipped' })
    expect(t.options.api.save).not.toHaveBeenCalled()
    expect(t.held.confirm).toHaveBeenCalledOnce()
    expect(t.time.pending()).toBe(0)
  })

  it('navigator 仍在线但请求失败也关上传；网络持续失败的复核不能绕过退避', async () => {
    const t = await connected()
    t.session.stopCapturing()
    t.held.confirm.mockImplementation(async () => {
      t.connection.failed(t.connection.beginRequest())
      return { kind: 'unknown', error: new NetworkError() }
    })
    t.connection.failed(t.connection.beginRequest())
    t.page.edit()
    expect(await t.save()).toMatchObject({ kind: 'skipped' })
    await t.time.advance(1_999)
    expect(t.held.confirm).not.toHaveBeenCalled()
    await t.time.advance(1)
    expect(t.held.confirm).toHaveBeenCalledOnce()
    await t.time.advance(1_999)
    expect(t.held.confirm).toHaveBeenCalledOnce()
    await t.time.advance(1)
    expect(t.held.confirm).toHaveBeenCalledTimes(2)
    await t.time.advance(3_999)
    expect(t.held.confirm).toHaveBeenCalledTimes(2)
    expect(t.options.api.save).not.toHaveBeenCalled()
  })

  it('离线之前发出的心跳晚到成功只能触发核对，不能给予上传许可', async () => {
    const connection = createConnectionState({ online: true, now: Date.now })
    const t = fixture({ connection })
    const heartbeat = deferred<RenewedEditLease>()
    const checking = deferred<RenewedEditLease>()
    const renew = vi.spyOn(t.options.api.editLease, 'renew').mockReturnValueOnce(heartbeat.promise).mockReturnValueOnce(checking.promise)
    const acquisition = await t.session.acquire()
    if (acquisition.kind !== 'acquired')
      throw new Error('未取得租约')
    await prepare(t.session, acquisition.lease)
    const page = editorFixture()
    t.session.startSaving(page.editor, INITIAL)
    t.session.stopCapturing()
    await t.time.advance(30_000)
    expect(renew).toHaveBeenCalledOnce()
    connection.setBrowserOnline(false)
    connection.setBrowserOnline(true)
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2))
    heartbeat.resolve({ expiresAt: '2026-10-10T05:00:00.000Z', request: null, localKeyVersion: null })
    await settle()
    page.edit()
    const capture = () => t.session.draft!.capture({ editorSeq: 1, snapshot: '心跳晚到', formulasPending: false, dedupe: false })
    expect(await t.session.coordinator!.save(capture, { dedupe: false })).toMatchObject({ kind: 'skipped' })
    checking.resolve({ expiresAt: '2026-10-10T05:00:00.000Z', request: null, localKeyVersion: null })
    await settle()
    expect(await t.session.coordinator!.save(capture, { dedupe: false })).toMatchObject({ kind: 'saved' })
  })

  it('连接和编辑权都复核成功，自动保存仍遵守原请求的 Retry-After', async () => {
    const t = await connected()
    vi.mocked(t.options.api.save).mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙', { retryAfterSeconds: 30 }))
    t.page.edit()
    await t.time.advance(2_000)
    await vi.waitFor(() => expect(t.options.api.save).toHaveBeenCalledOnce())
    await settle()
    const first = vi.mocked(t.options.api.save).mock.calls[0]!
    t.connection.setBrowserOnline(false)
    t.connection.setBrowserOnline(true)
    t.connection.succeeded(t.connection.beginRequest())
    await settle()
    expect(t.held.confirm).toHaveBeenCalledOnce()
    await t.time.advance(29_999)
    expect(t.options.api.save).toHaveBeenCalledOnce()
    await t.time.advance(1)
    await vi.waitFor(() => expect(t.options.api.save).toHaveBeenCalledTimes(2))
    expect(vi.mocked(t.options.api.save).mock.calls[1]).toEqual(first)
  })

  it('旧确认跨过退出登录和同用户重新登录，也必须重做确认', async () => {
    const t = await connected()
    t.session.stopCapturing()
    const old = deferred<LeaseVerdict>()
    const fresh = deferred<LeaseVerdict>()
    t.held.confirm.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    t.connection.setBrowserOnline(false)
    t.connection.setBrowserOnline(true)
    await settle()
    t.setActive(false)
    t.session.discardDraftKey()
    t.setActive(true)
    t.connection.succeeded(t.connection.beginRequest())
    old.resolve({ kind: 'current' })
    await settle()
    t.page.edit()
    expect(await t.save()).toMatchObject({ kind: 'skipped' })
    await t.time.advance(2_000)
    expect(t.held.confirm).toHaveBeenCalledTimes(2)
    fresh.resolve({ kind: 'current' })
    await settle()
    expect(await t.save()).toMatchObject({ kind: 'saved' })
  })

  it('同一租约更换草稿来源和协调器，旧确认不能给予新协调器上传许可', async () => {
    const t = await connected()
    t.session.stopCapturing()
    const old = deferred<LeaseVerdict>()
    const fresh = deferred<LeaseVerdict>()
    t.held.confirm.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    t.connection.setBrowserOnline(false)
    t.connection.setBrowserOnline(true)
    await settle()
    t.session.stopSaving()
    await t.session.prepareDraft(INITIAL)
    const next = editorFixture()
    t.session.startSaving(next.editor, INITIAL)
    t.session.stopCapturing()
    old.resolve({ kind: 'current' })
    await settle()
    next.edit()
    const capture = () => t.session.draft!.capture({ editorSeq: 1, snapshot: '新协调器', formulasPending: false, dedupe: false })
    expect(await t.session.coordinator!.save(capture, { dedupe: false })).toMatchObject({ kind: 'skipped' })
    await t.time.advance(2_000)
    expect(t.held.confirm).toHaveBeenCalledTimes(2)
    fresh.resolve({ kind: 'current' })
    await settle()
    expect(await t.session.coordinator!.save(capture, { dedupe: false })).toMatchObject({ kind: 'saved' })
    expect(t.options.api.save).toHaveBeenCalledOnce()
  })

  it('登录恢复等待旧在途核对结束后另核对当前代，不把旧 Promise 完成当作放行', async () => {
    const t = await connected()
    t.session.stopCapturing()
    const old = deferred<LeaseVerdict>()
    const fresh = deferred<LeaseVerdict>()
    t.held.confirm.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    t.connection.setBrowserOnline(false)
    t.connection.setBrowserOnline(true)
    await vi.waitFor(() => expect(t.held.confirm).toHaveBeenCalledOnce())
    t.setActive(false)
    t.session.discardDraftKey()
    t.setActive(true)
    const resumed = t.session.resumeLease()
    await settle()
    expect(t.held.confirm).toHaveBeenCalledOnce()
    old.resolve({ kind: 'current' })
    await vi.waitFor(() => expect(t.held.confirm).toHaveBeenCalledTimes(2))
    t.page.edit()
    expect(await t.save()).toMatchObject({ kind: 'skipped' })
    fresh.resolve({ kind: 'current' })
    await resumed
    expect(await t.save()).toMatchObject({ kind: 'saved' })
  })

  it('真正重新登录只消耗一次立即核对机会；再确认本人仍保留未知核对的退避', async () => {
    const t = await connected()
    t.session.stopCapturing()
    t.held.confirm.mockResolvedValueOnce({ kind: 'unknown', error: new NetworkError() })
    t.connection.failed(t.connection.beginRequest())
    await t.time.advance(2_000)
    expect(t.held.confirm).toHaveBeenCalledOnce()
    t.setActive(false)
    t.session.discardDraftKey()
    t.setActive(true)
    t.held.confirm.mockResolvedValueOnce({ kind: 'unknown', error: new NetworkError() })
    await t.session.resumeLease()
    expect(t.held.confirm).toHaveBeenCalledTimes(2)
    await t.session.resumeLease()
    expect(t.held.confirm).toHaveBeenCalledTimes(2)
    await t.time.advance(3_999)
    expect(t.held.confirm).toHaveBeenCalledTimes(2)
    await t.time.advance(1)
    expect(t.held.confirm).toHaveBeenCalledTimes(3)
    t.page.edit()
    expect(await t.save()).toMatchObject({ kind: 'saved' })
  })
})

describe('最终发送点与终态核对', () => {
  it('排队中的 B 在 A 已发送后断网：确认 A，保留 B，不多发请求', async () => {
    const t = await connected()
    t.session.stopCapturing()
    const first = deferred<Awaited<ReturnType<typeof t.options.api.save>>>()
    vi.mocked(t.options.api.save).mockReturnValueOnce(first.promise)
    t.page.edit()
    const a = t.save()
    await vi.waitFor(() => expect(t.options.api.save).toHaveBeenCalledOnce())
    t.page.edit()
    const b = t.save()
    t.connection.setBrowserOnline(false)
    first.resolve({ revision: 4, savedAt: '2026-10-10T05:00:00.000Z', unchanged: false })
    expect(await a).toMatchObject({ kind: 'saved' })
    expect(await b).toMatchObject({ kind: 'skipped' })
    expect(t.options.api.save).toHaveBeenCalledOnce()
    expect(t.session.baseRevision()).toBe(4)
    expect(t.session.coordinator!.hasUnsavedWork()).toBe(true)
  })

  it('请求标记落盘期间断网，即使外层错误恢复协调器，也不能发 HTTP 或制造 unknown', async () => {
    const t = await connected()
    t.session.stopCapturing()
    const draft = t.session.draft!
    const marked = deferred<void>()
    const original = draft.markInFlight
    const mark = vi.spyOn(draft, 'markInFlight').mockImplementation(async (...args) => {
      const result = await original(...args)
      await marked.promise
      return result
    })
    t.page.edit()
    const saving = t.save()
    await vi.waitFor(() => expect(mark).toHaveBeenCalledOnce())
    t.connection.setBrowserOnline(false)
    t.session.coordinator!.resume()
    marked.resolve()
    expect(await saving).toMatchObject({ kind: 'skipped', reason: 'stopped' })
    expect(t.options.api.save).not.toHaveBeenCalled()
    expect(t.session.coordinator!.hasUnknownOutcome()).toBe(false)
    expect(t.session.coordinator!.view().problem).toBeUndefined()
  })

  it('保存遭已过期拒绝，lose 等待期间丢许可，续上回包也不能重发', async () => {
    const t = await connected()
    t.session.stopCapturing()
    const recovered = deferred<{ kind: 'held' }>()
    t.held.lose.mockReturnValue(recovered.promise)
    vi.mocked(t.options.api.save).mockRejectedValueOnce(new ApiError(409, 'EDIT_LEASE_LOST', '已过期', { details: { reason: 'expired' } }))
    t.page.edit()
    const saving = t.save()
    await vi.waitFor(() => expect(t.held.lose).toHaveBeenCalledOnce())
    t.connection.setBrowserOnline(false)
    recovered.resolve({ kind: 'held' })
    expect(await saving).toMatchObject({ kind: 'skipped' })
    expect(t.options.api.save).toHaveBeenCalledOnce()
    expect(t.session.coordinator!.hasUnknownOutcome()).toBe(false)
  })

  it('失效后仅原样核对旧 unknown；离线不发，被拒绝也不能续上或发新正文', async () => {
    const t = await connected()
    t.session.stopCapturing()
    vi.mocked(t.options.api.save).mockRejectedValueOnce(new NetworkError())
    t.page.edit()
    expect(await t.save()).toMatchObject({ kind: 'failed' })
    const first = vi.mocked(t.options.api.save).mock.calls[0]!
    t.session.detachLease()
    t.session.releaseLock()
    t.session.coordinator!.stop()
    t.connection.setBrowserOnline(false)
    expect(await t.session.coordinator!.replayUnknownOutcome()).toBe('unknown')
    expect(t.options.api.save).toHaveBeenCalledOnce()
    t.page.edit()
    t.connection.setBrowserOnline(true)
    vi.mocked(t.options.api.save).mockRejectedValueOnce(new ApiError(409, 'EDIT_LEASE_LOST', '失效', { details: { reason: 'expired' } }))
    expect(await t.session.coordinator!.replayUnknownOutcome()).toBe('not-committed')
    expect(t.options.api.save).toHaveBeenCalledTimes(2)
    expect(vi.mocked(t.options.api.save).mock.calls[1]).toEqual(first)
    expect(t.held.lose).not.toHaveBeenCalled()
    expect(t.held.confirm).not.toHaveBeenCalled()
    expect(t.session.baseRevision()).toBe(3)
    expect(first[0]).toBe(DOCUMENT)
  })
})
