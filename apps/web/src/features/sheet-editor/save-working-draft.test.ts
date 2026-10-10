import type { SaveContentResponse } from '@nerve-office/contracts'
import type { SaveRequest, SendSave } from './save-coordinator.ts'
import type { DraftCaptureRef, WorkingDraft } from './working-draft.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { gunzipBytes } from '../../shared/outbox/draft-codec.ts'
import { CLIENT_INSTANCE_ID } from '../../shared/outbox/draft-record.test-support.ts'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { settle } from './fake-lease-clock.test-support.ts'
import { createMemoryWorkingDraft } from './memory-working-draft.ts'
import { DRAFT_KEY, DRAFT_OPTIONS, persistentHarness } from './outbox/persistent-working-draft.test-support.ts'
import { createPersistentWorkingDraft } from './outbox/persistent-working-draft.ts'
import { createSaveCoordinator } from './save-coordinator.ts'

const EXPLICIT = { dedupe: false }
const AUTO = { dedupe: true }
const saved = (revision: number): SaveContentResponse => ({ revision, savedAt: '2026-10-10T09:00:00.000Z', unchanged: false })

function setup(draft: WorkingDraft) {
  let editorSeq = 0
  const sends: { readonly request: SaveRequest, readonly body: Uint8Array<ArrayBuffer>, readonly result: ReturnType<typeof deferred<SaveContentResponse>> }[] = []
  const send = vi.fn<SendSave>(async (request, body) => {
    const result = deferred<SaveContentResponse>()
    sends.push({ request, body, result })
    return result.promise
  })
  const onDraftResult = vi.fn()
  const reportError = vi.fn()
  let id = 0
  const coordinator = createSaveCoordinator({
    editor: { changeSeq: () => editorSeq, uncommittedInput: () => 'none', onChange: () => () => {}, onUncommittedInputChange: () => () => {} },
    draft,
    send,
    baseRevision: 7,
    clientInstanceId: CLIENT_INSTANCE_ID,
    newRequestId: () => `save-${++id}`,
    now: () => 1_000,
    onUnauthenticated: vi.fn(),
    onSessionStale: vi.fn(),
    reportError,
    onDraftResult,
  })
  const capture = (snapshot: string, seq = ++editorSeq): DraftCaptureRef => {
    editorSeq = seq
    return draft.capture({ snapshot, editorSeq: seq, formulasPending: false, dedupe: false })
  }
  const latest = (): DraftCaptureRef => {
    const current = draft.view()
    if (current.kind !== 'working')
      throw new Error('需要已捕获的工作内容')
    return current.ref
  }
  const sent = async (count: number) => {
    await vi.waitFor(() => expect(sends).toHaveLength(count), { timeout: 500 })
    return sends[count - 1]!
  }
  return { coordinator, capture, latest, sent, sends, send, onDraftResult, reportError }
}

async function text(body: Uint8Array<ArrayBuffer>): Promise<string> {
  return new TextDecoder().decode(await gunzipBytes(body))
}

describe('保存协调与唯一工作草稿整合', () => {
  it('新请求在实际发送前失去许可：不制造 unknown，释放本次 pin，下一次使用新标识', async () => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.send.mockResolvedValueOnce({ kind: 'not-sent' })
    context.capture('没有发出的 A')
    expect(await context.coordinator.save(context.latest, EXPLICIT)).toEqual({ kind: 'skipped', reason: 'stopped' })
    expect(context.coordinator.hasUnknownOutcome()).toBe(false)
    expect(context.coordinator.view().problem).toBeUndefined()
    expect(context.sends).toHaveLength(0)
    const prepared = await draft.prepare(context.latest())
    expect(prepared.kind).toBe('prepared')
    if (prepared.kind === 'prepared')
      draft.release(prepared)
    context.capture('新的 B')
    const second = context.coordinator.save(context.latest, EXPLICIT)
    const call = await context.sent(1)
    expect(call.request.requestId).toBe('save-2')
    expect(await text(call.body)).toBe('新的 B')
    call.result.resolve(saved(8))
    await second
    context.coordinator.dispose()
    draft.dispose()
  })

  it('旧 unknown 本轮未发出：不覆盖原错误/原字节，不释放 pin；许可恢复后仍先核对 A 再发 B', async () => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.capture('原 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const original = await context.sent(1)
    original.result.reject(new NetworkError('之前已经发出，结果未知'))
    await first
    const problem = context.coordinator.view().problem
    context.capture('新 B')
    context.send.mockResolvedValueOnce({ kind: 'not-sent' })
    expect(await context.coordinator.save(context.latest, EXPLICIT)).toEqual({ kind: 'skipped', reason: 'stopped' })
    expect(context.coordinator.hasUnknownOutcome()).toBe(true)
    expect(context.coordinator.view().problem).toBe(problem)
    context.send.mockResolvedValueOnce({ kind: 'not-sent' })
    expect(await context.coordinator.replayUnknownOutcome()).toBe('unknown')
    expect(context.coordinator.hasUnknownOutcome()).toBe(true)
    const retry = context.coordinator.save(context.latest, EXPLICIT)
    const replay = await context.sent(2)
    expect(replay.request).toEqual(original.request)
    expect(replay.body).toBe(original.body)
    replay.result.resolve(saved(8))
    const latest = await context.sent(3)
    expect(await text(latest.body)).toBe('新 B')
    latest.result.resolve(saved(9))
    await retry
    expect(context.coordinator.hasUnknownOutcome()).toBe(false)
    context.coordinator.dispose()
    draft.dispose()
  })

  it('普通重放仍需保存许可，停用后的原请求收尾才使用 reconcile 意图', async () => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.capture('唯一请求')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const a = await context.sent(1)
    expect(context.send.mock.calls[0]?.[2]).toBe('save')
    a.result.reject(new NetworkError('未知'))
    await first
    const second = context.coordinator.save(context.latest, EXPLICIT)
    const b = await context.sent(2)
    expect(context.send.mock.calls[1]?.[2]).toBe('save')
    b.result.reject(new NetworkError('仍未知'))
    await second
    context.coordinator.stop()
    const ending = context.coordinator.replayUnknownOutcome()
    const c = await context.sent(3)
    expect(context.send.mock.calls[2]?.[2]).toBe('reconcile')
    expect(c.request).toEqual(a.request)
    expect(c.body).toBe(a.body)
    c.result.resolve(saved(8))
    expect(await ending).toBe('committed')
    context.coordinator.dispose()
    draft.dispose()
  })

  it.each([false, true])('本机栅栏裁决回调未完成不能发 HTTP；裁决后停止=%s', async (stopped) => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    vi.spyOn(draft, 'markInFlight').mockResolvedValueOnce({ kind: 'fenced', reason: 'not-writer' })
    const verdict = deferred<void>()
    context.onDraftResult.mockImplementationOnce(async () => {
      await verdict.promise
      if (stopped)
        context.coordinator.stop()
    })
    context.capture('等待裁决的内容')
    const saving = context.coordinator.save(context.latest, EXPLICIT)
    await vi.waitFor(() => expect(context.onDraftResult).toHaveBeenCalledOnce())
    expect(context.sends).toHaveLength(0)
    verdict.resolve()
    if (stopped) {
      expect(await saving).toMatchObject({ kind: 'skipped', reason: 'stopped' })
      expect(context.sends).toHaveLength(0)
    }
    else {
      const call = await context.sent(1)
      call.result.resolve(saved(8))
      expect(await saving).toMatchObject({ kind: 'saved' })
    }
    context.coordinator.dispose()
    draft.dispose()
  })

  it('未知 HTTP 已结束后才认出已提交，后续保存等本机确认并释放旧 pin', async () => {
    const h = await persistentHarness()
    const draft = createPersistentWorkingDraft(h.options)
    const context = setup(draft)
    context.capture('旧 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    old.result.reject(new NetworkError('未知'))
    await first
    context.capture('新 B')
    const allowed = deferred<void>()
    const confirming = deferred<void>()
    const confirm = draft.confirm.bind(draft)
    vi.spyOn(draft, 'confirm').mockImplementationOnce(async (...args) => {
      confirming.resolve()
      await allowed.promise
      return confirm(...args)
    })
    expect(context.coordinator.adoptOwnRevision(8, { clientInstanceId: CLIENT_INSTANCE_ID, localSeq: old.request.localSeq })).toBe(true)
    await confirming.promise
    const saving = context.coordinator.save(context.latest, EXPLICIT)
    await settle()
    expect(context.sends).toHaveLength(1)
    allowed.resolve()
    const next = await context.sent(2)
    expect(next.request.baseRevision).toBe(8)
    expect(await text(next.body)).toBe('新 B')
    next.result.resolve(saved(9))
    await saving
    context.coordinator.dispose()
    draft.dispose()
  })

  it('保存入队后微任务才认出旧请求，也等待最新本机确认链再准备', async () => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.capture('旧 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    old.result.reject(new NetworkError('未知'))
    await first
    context.capture('新 B')
    const allowed = deferred<void>()
    const confirming = deferred<void>()
    const confirm = draft.confirm.bind(draft)
    vi.spyOn(draft, 'confirm').mockImplementationOnce(async (...args) => {
      confirming.resolve()
      await allowed.promise
      return confirm(...args)
    })
    const saving = context.coordinator.save(context.latest, EXPLICIT)
    let outcome: unknown
    void saving.then((result) => {
      outcome = result
    })
    queueMicrotask(() => context.coordinator.adoptOwnRevision(8, { clientInstanceId: CLIENT_INSTANCE_ID, localSeq: old.request.localSeq }))
    await confirming.promise
    await settle()
    expect(outcome).toBeUndefined()
    expect(context.sends).toHaveLength(1)
    allowed.resolve()
    const next = await context.sent(2)
    expect(next.request.baseRevision).toBe(8)
    expect(await text(next.body)).toBe('新 B')
    next.result.resolve(saved(9))
    expect(await saving).toMatchObject({ kind: 'saved' })
    context.coordinator.dispose()
    draft.dispose()
  })

  it('外部核对和随后排上的保存共用请求队列，不并行重放同一个 pin', async () => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.capture('旧 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    old.result.reject(new NetworkError('未知'))
    await first
    context.capture('新 B')
    const replaying = context.coordinator.replayUnknownOutcome()
    const saving = context.coordinator.save(context.latest, EXPLICIT)
    const replay = await context.sent(2)
    await settle()
    expect(context.sends).toHaveLength(2)
    expect(replay.request).toBe(old.request)
    replay.result.resolve(saved(8))
    expect(await replaying).toBe('committed')
    const next = await context.sent(3)
    expect(await text(next.body)).toBe('新 B')
    next.result.resolve(saved(9))
    await saving
    context.coordinator.dispose()
    draft.dispose()
  })

  it('已结束的未知请求被续租确认后，同正文新引用可去重并确认本机', async () => {
    const h = await persistentHarness()
    const draft = createPersistentWorkingDraft(h.options)
    const context = setup(draft)
    context.capture('同一份内容')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    old.result.reject(new NetworkError('未知'))
    await first
    context.capture('同一份内容')
    await draft.ready(context.latest())
    expect(context.coordinator.adoptOwnRevision(8, { clientInstanceId: CLIENT_INSTANCE_ID, localSeq: old.request.localSeq })).toBe(true)
    await context.coordinator.settled()
    expect(await context.coordinator.save(context.latest, AUTO)).toEqual({ kind: 'deduped' })
    expect(context.sends).toHaveLength(1)
    expect(h.store.rawDraft(DRAFT_KEY)).toBeUndefined()
    expect(context.coordinator.view().unsaved).toBe(false)
    context.coordinator.dispose()
    draft.dispose()
  })

  it('未知请求核对得到限流时把 Retry-After 交回调度，不立即发送新内容', async () => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.capture('未知 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    old.result.reject(new NetworkError('未知'))
    await first
    context.capture('新 B')
    const saving = context.coordinator.save(context.latest, AUTO)
    const replay = await context.sent(2)
    replay.result.reject(new ApiError(429, 'TOO_MANY_REQUESTS', '稍后再试', { retryAfterSeconds: 30 }))
    expect(await saving).toMatchObject({ kind: 'failed', failure: { kind: 'retry', retryAfterMs: 30_000 } })
    expect(context.sends).toHaveLength(2)
    context.coordinator.dispose()
    draft.dispose()
  })

  it.each(['same-ref', 'same-hash', 'different', 'no-digest'] as const)('旧重放被拒后按内容决定是否继续：%s', async (kind) => {
    const h = kind === 'no-digest' ? await persistentHarness() : undefined
    const persistent = h === undefined ? undefined : createPersistentWorkingDraft(h.options)
    h?.changeKey(undefined)
    await persistent?.setKey(undefined)
    const draft = persistent ?? createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.capture('旧 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    old.result.reject(new NetworkError('未知'))
    await first
    if (kind !== 'same-ref')
      context.capture(kind === 'different' ? '新 B' : '旧 A')
    await draft.ready(context.latest())
    const saving = context.coordinator.save(context.latest, AUTO)
    const replay = await context.sent(2)
    replay.result.reject(new ApiError(422, 'SNAPSHOT_INVALID', '内容不合格'))
    if (kind === 'same-ref' || kind === 'same-hash') {
      await settle()
      expect(context.sends).toHaveLength(2)
      expect(await saving).toMatchObject({ kind: 'failed', failure: { kind: 'content' } })
      // 显式保存仍允许主动重试，同内容不能被自动去重策略挡住。
      const explicit = context.coordinator.save(context.latest, EXPLICIT)
      const next = await context.sent(3)
      expect(next.request.requestId).not.toBe(old.request.requestId)
      next.result.resolve(saved(8))
      await explicit
    }
    else {
      const next = await context.sent(3)
      expect(await text(next.body)).toBe(kind === 'different' ? '新 B' : '旧 A')
      expect(next.request.requestId).not.toBe(old.request.requestId)
      next.result.resolve(saved(8))
      await saving
    }
    context.coordinator.dispose()
    draft.dispose()
  })

  it('普通保存核对在本机标记期间被停住就不发，显式核对仍可继续', async () => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.capture('未知 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    old.result.reject(new NetworkError('未知'))
    await first
    const allowed = deferred<void>()
    const marking = deferred<void>()
    const mark = draft.markInFlight.bind(draft)
    vi.spyOn(draft, 'markInFlight').mockImplementationOnce(async (...args) => {
      marking.resolve()
      await allowed.promise
      return mark(...args)
    })
    const saving = context.coordinator.save(context.latest, AUTO)
    await marking.promise
    context.coordinator.stop()
    allowed.resolve()
    expect(await saving).toEqual({ kind: 'skipped', reason: 'stopped' })
    expect(context.sends).toHaveLength(1)
    expect(context.coordinator.hasUnknownOutcome()).toBe(true)
    const checking = context.coordinator.replayUnknownOutcome()
    const replay = await context.sent(2)
    expect(replay.request).toBe(old.request)
    replay.result.resolve(saved(8))
    expect(await checking).toBe('committed')
    context.coordinator.dispose()
    draft.dispose()
  })

  it('编辑计数归零但高水位继续；上传不带 JSON，使用来源的格式和真实序号', async () => {
    const h = await persistentHarness()
    const draft = createPersistentWorkingDraft({ ...h.options, initialDraftSeq: 40 })
    const context = setup(draft)
    const ref = context.capture('从四十继续', 0)
    const saving = context.coordinator.save(() => ref, EXPLICIT)
    const call = await context.sent(1)
    expect(call.request).toMatchObject({ localSeq: 41, baseRevision: 7, format: h.options.format })
    expect(call.request).not.toHaveProperty('snapshot')
    expect(await text(call.body)).toBe('从四十继续')
    expect(h.store.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 41, inFlight: { requestId: call.request.requestId, localSeq: 41 } })
    call.result.resolve(saved(8))
    await saving
    expect(h.store.rawDraft(DRAFT_KEY)).toBeUndefined()
    context.coordinator.dispose()
    draft.dispose()
  })

  it('实际写入和在途标记两次等待都结束后才能发 HTTP', async () => {
    const h = await persistentHarness()
    const draft = createPersistentWorkingDraft(h.options)
    const context = setup(draft)
    const writing = h.store.holdNext('writeDraft')
    const marked = deferred<void>()
    const marking = deferred<void>()
    const original = h.writer.markInFlight.bind(h.writer)
    vi.spyOn(h.writer, 'markInFlight').mockImplementationOnce(async (...args) => {
      marking.resolve()
      await marked.promise
      return original(...args)
    })
    const ref = context.capture('先写本机')
    const saving = context.coordinator.save(() => ref, EXPLICIT)
    await writing.reached
    expect(context.send).not.toHaveBeenCalled()
    writing.release()
    await vi.waitFor(() => expect(h.writer.markInFlight).toHaveBeenCalledOnce(), { timeout: 500 })
    await marking.promise
    expect(context.send).not.toHaveBeenCalled()
    marked.resolve()
    ;(await context.sent(1)).result.resolve(saved(8))
    await saving
    context.coordinator.dispose()
    draft.dispose()
  })

  it('写满仍发送原正文，并上报本机标记只能留内存的结果', async () => {
    const h = await persistentHarness()
    h.store.failNext('writeDraft', { kind: 'quota' })
    const draft = createPersistentWorkingDraft(h.options)
    const context = setup(draft)
    const ref = context.capture('没有丢掉的写满内容')
    const saving = context.coordinator.save(() => ref, EXPLICIT)
    const call = await context.sent(1)
    expect(await text(call.body)).toBe('没有丢掉的写满内容')
    expect(context.onDraftResult).toHaveBeenCalledWith({ kind: 'memory', reason: 'quota' })
    call.result.resolve(saved(8))
    expect(await saving).toMatchObject({ kind: 'saved' })
    context.coordinator.dispose()
    draft.dispose()
  })

  it('密钥暂不可用仍上传本次正文，但本机状态保持 no-key', async () => {
    const h = await persistentHarness()
    const draft = createPersistentWorkingDraft(h.options)
    h.changeKey(undefined)
    await draft.setKey(undefined)
    const context = setup(draft)
    context.capture('还没有可用密钥')
    const saving = context.coordinator.save(context.latest, EXPLICIT)
    const call = await context.sent(1)
    expect(await text(call.body)).toBe('还没有可用密钥')
    expect(context.onDraftResult).toHaveBeenCalledWith({ kind: 'memory', reason: 'no-key' })
    call.result.resolve(saved(8))
    expect(await saving).toMatchObject({ kind: 'saved' })
    expect(context.coordinator.view().unsaved).toBe(false)
    context.coordinator.dispose()
    draft.dispose()
  })

  it('本机确认失败不回退云端事实，下一份仍沿确认后的基准保存', async () => {
    const h = await persistentHarness()
    const draft = createPersistentWorkingDraft(h.options)
    vi.spyOn(h.session, 'confirm').mockRejectedValueOnce(new Error('本机回包失败'))
    const context = setup(draft)
    context.capture('旧 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    context.capture('新 B')
    await draft.ready(context.latest())
    old.result.resolve(saved(8))
    expect(await first).toMatchObject({ kind: 'saved' })
    expect(context.coordinator.baseRevision()).toBe(8)
    expect(context.coordinator.view().unsaved).toBe(true)
    expect(await draft.readLatest()).toMatchObject({ snapshot: '新 B' })
    const saving = context.coordinator.save(context.latest, EXPLICIT)
    const next = await context.sent(2)
    expect(next.request.baseRevision).toBe(8)
    expect(await text(next.body)).toBe('新 B')
    next.result.resolve(saved(9))
    await saving
    expect(context.coordinator.view().unsaved).toBe(false)
    context.coordinator.dispose()
    draft.dispose()
  })

  it('旧请求先原样重放；期间持续编辑，之后才发送最新内容和新基准', async () => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.capture('旧未知 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    old.result.reject(new NetworkError('回包丢失'))
    await first
    context.capture('待上传 B')
    const next = context.coordinator.save(context.latest, EXPLICIT)
    const replay = await context.sent(2)
    expect(replay.request).toBe(old.request)
    expect(replay.body).toBe(old.body)
    context.capture('核对期间更新到 C')
    replay.result.resolve(saved(8))
    const current = await context.sent(3)
    expect(await text(current.body)).toBe('核对期间更新到 C')
    expect(current.request).toMatchObject({ baseRevision: 8, localSeq: 3 })
    expect(current.request.requestId).not.toBe(old.request.requestId)
    current.result.resolve(saved(9))
    await next
    expect(context.coordinator.view()).toMatchObject({ status: 'clean', unsaved: false })
    context.coordinator.dispose()
    draft.dispose()
  })

  it('核对仍未知或没有权限得知时保留旧 pin，新内容不发出', async () => {
    const draft = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    const context = setup(draft)
    context.capture('未知 A')
    const first = context.coordinator.save(context.latest, EXPLICIT)
    const old = await context.sent(1)
    old.result.reject(new NetworkError('未知'))
    await first
    context.capture('新 B')
    const retry = context.coordinator.save(context.latest, EXPLICIT)
    const replay = await context.sent(2)
    expect(replay.body).toBe(old.body)
    replay.result.reject(new ApiError(401, 'SESSION_EXPIRED', '登录过期'))
    await retry
    expect(context.sends).toHaveLength(2)
    expect(context.coordinator.hasUnknownOutcome()).toBe(true)
    expect(await draft.readLatest()).toMatchObject({ snapshot: '新 B' })
    context.coordinator.dispose()
    draft.dispose()
  })

  it('旧云端确认保留新捕获，后续自动去重同内容也确认本机新行', async () => {
    const h = await persistentHarness()
    const draft = createPersistentWorkingDraft(h.options)
    const context = setup(draft)
    const first = context.capture('相同内容')
    const saving = context.coordinator.save(() => first, EXPLICIT)
    const call = await context.sent(1)
    const next = context.capture('相同内容')
    await draft.ready(next)
    call.result.resolve(saved(8))
    await saving
    expect(h.store.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 2, baseRevision: 8 })
    expect(context.coordinator.view().unsaved).toBe(true)
    expect(await context.coordinator.save(() => next, AUTO)).toEqual({ kind: 'deduped' })
    expect(context.sends).toHaveLength(1)
    expect(context.coordinator.view().unsaved).toBe(false)
    expect(h.store.rawDraft(DRAFT_KEY)).toBeUndefined()
    context.coordinator.dispose()
    draft.dispose()
  })

  it('续上已认出的当前上传，HTTP 晚到网络失败仍按云端成功，本机确认只处理一次', async () => {
    const h = await persistentHarness()
    const draft = createPersistentWorkingDraft(h.options)
    const confirm = vi.spyOn(draft, 'confirm')
    const context = setup(draft)
    const ref = context.capture('已经存上的')
    const saving = context.coordinator.save(() => ref, EXPLICIT)
    const call = await context.sent(1)
    expect(context.coordinator.adoptOwnRevision(8, { clientInstanceId: CLIENT_INSTANCE_ID, localSeq: call.request.localSeq })).toBe(true)
    call.result.reject(new NetworkError('晚到失败'))
    expect(await saving).toMatchObject({ kind: 'saved' })
    await context.coordinator.settled()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(context.coordinator.view()).toMatchObject({ unsaved: false, status: 'clean' })
    expect(context.coordinator.baseRevision()).toBe(8)
    await settle()
    context.coordinator.dispose()
    draft.dispose()
  })
})
