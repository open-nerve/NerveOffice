import type { WorkingDraft } from '../../../shared/local-drafts/working-draft.ts'
import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { LocalKeyKeeper } from '../../../shared/outbox/local-key.ts'
import type { OutboxHost } from '../../../shared/outbox/outbox-host.ts'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryWorkingDraft } from '../../../shared/local-drafts/memory-working-draft.ts'
import { gunzipBytes } from '../../../shared/outbox/draft-codec.ts'
import { NOW } from '../../../shared/outbox/draft-record.test-support.ts'
import { fakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import { createDraftWriter } from '../../../shared/outbox/draft-writer.ts'
import { testSessionPermit } from '../../../shared/outbox/session-fence.test-support.ts'
import { prepareOutboxSession } from './outbox-session.ts'
import { DRAFT_KEY, DRAFT_OPTIONS, newKey } from './persistent-working-draft.test-support.ts'
import { createPersistentWorkingDraft } from './persistent-working-draft.ts'

const INITIAL = { editorSeq: 0, snapshot: '恢复后收齐的内容', formulasPending: false }

function initialRef(source: WorkingDraft) {
  const view = source.view()
  expect(view.kind).toBe('working')
  if (view.kind !== 'working')
    throw new Error('恢复初值必须是来源的一份未确认内容')
  return view.ref
}

async function recovery(enabled = true) {
  const fake = fakeDraftStore()
  const key = await newKey(1)
  const originalWriter = { writeEpoch: 2, writerId: 'old-writer' }
  const old = createDraftWriter({ store: fake.store, now: () => NOW })
  await old.setKey(key)
  await old.register(DRAFT_KEY, originalWriter, false)
  expect(await old.write({ key: DRAFT_KEY, writer: originalWriter, draftSeq: 41, baseRevision: 7, writtenBy: 'old-page', format: DRAFT_OPTIONS.format, formulasPending: true, inFlight: null, bytes: new TextEncoder().encode('原在途内容'), dedupe: false })).toMatchObject({ kind: 'written' })
  await old.markInFlight(DRAFT_KEY, originalWriter, { requestId: 'old-request', clientInstanceId: 'old-page', localSeq: 41, sentAt: NOW })
  fake.putRaw('writers', DRAFT_KEY, { ...DRAFT_KEY, ...originalWriter, lastDraftSeq: 90, registeredAt: NOW })
  let current: LocalKeyHandle | undefined = key
  const keeper: LocalKeyKeeper = {
    current: () => current,
    ensure: async () => current ?? { kind: 'unavailable', retryAt: NOW + 1_000 },
    subscribe: () => () => {},
    discard: () => { current = undefined },
    observeVersion: () => {},
  }
  const writer = createDraftWriter({ store: fake.store, now: () => NOW + 1 })
  const hostValue: OutboxHost = { kind: 'in-process', writer, broken: () => false, dispose: () => writer.dispose() }
  const host = vi.fn(async () => hostValue)
  const session = prepareOutboxSession({ permit: testSessionPermit, enabled, recoverExisting: true, key: DRAFT_KEY, writeEpoch: 3, newWriterId: () => 'recovery-writer', keeper, confirm: async () => ({ kind: 'current' }), host, persist: async () => ({ kind: 'denied' }), supported: () => true, still: () => true })
  expect(await session.ready()).toMatchObject({ kind: 'memory', reason: enabled ? 'existing-draft' : 'disabled' })
  return { fake, key, old, writer, host, session, options: { ...DRAFT_OPTIONS, baseRevision: 8, initialDraftSeq: 0, initialCapture: INITIAL, key: DRAFT_KEY, session } }
}

describe('恢复初值沿用唯一 WorkingDraft 来源', () => {
  it('editorSeq=0 仍未确认，持久序号高于高水位；接手新正文，普通上传/确认沿同一个引用', async () => {
    const h = await recovery()
    const observed = await h.session.observeRecovery()
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    expect(h.fake.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 41, inFlight: { requestId: 'old-request', localSeq: 41 } })
    const source = createPersistentWorkingDraft({ ...h.options, recoveryObservation: observed.observation })
    const ref = initialRef(source)
    expect(ref).toMatchObject({ editorSeq: 0, draftSeq: 91 })
    expect(await source.ready(ref)).toMatchObject({ kind: 'ready', baseRevision: 8, local: { kind: 'persisted' }, confirmedRevision: undefined })
    expect(h.fake.calls).toContain('adoptObserved')
    expect(h.fake.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 91, baseRevision: 8, inFlight: null, formulasPending: false, writeEpoch: 3, writerId: 'recovery-writer' })
    expect(await source.readLatest()).toMatchObject({ ref, snapshot: INITIAL.snapshot })
    const prepared = await source.prepare(ref)
    if (prepared.kind !== 'prepared')
      throw new Error('缺少固定上传')
    expect(new TextDecoder().decode(await gunzipBytes(prepared.gzip))).toBe(INITIAL.snapshot)
    expect(await source.markInFlight(prepared, { requestId: 'new-request', clientInstanceId: 'new-page', localSeq: 91, sentAt: NOW + 1 })).toEqual({ kind: 'resealed' })
    expect(await source.confirm(prepared, 9)).toEqual({ kind: 'deleted' })
    expect(h.fake.rawDraft(DRAFT_KEY)).toBeUndefined()
    expect(source.view()).toMatchObject({ local: { kind: 'confirmed', revision: 9 } })
    source.release(prepared)
    source.dispose()
  })

  it('恢复引用不能通过复制字段或另一来源冒认，内存初值也可提供副本与上传', async () => {
    const source = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, initialDraftSeq: 90, reason: 'disabled', initialCapture: INITIAL })
    const ref = initialRef(source)
    expect(await source.ready(ref)).toMatchObject({ confirmedRevision: undefined, local: { kind: 'memory', reason: 'disabled' } })
    expect(await source.prepare({ ...ref })).toMatchObject({ kind: 'failed', error: { name: 'InvalidCapture' } })
    const other = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, reason: 'disabled' })
    expect(await other.prepare(ref)).toMatchObject({ kind: 'failed', error: { name: 'InvalidCapture' } })
    expect(await source.readLatest()).toMatchObject({ snapshot: INITIAL.snapshot })
    const prepared = await source.prepare(ref)
    if (prepared.kind !== 'prepared')
      throw new Error('缺少内存固定上传')
    expect(new TextDecoder().decode(await gunzipBytes(prepared.gzip))).toBe(INITIAL.snapshot)
    expect(await source.confirm({ ...prepared }, 9)).toMatchObject({ kind: 'failed' })
    source.dispose()
    other.dispose()
  })

  it.each(['quota', 'new-writer'] as const)('采用失败 %s 保留来源中的初值，原件不被覆盖，后续捕获不自动重接手', async (failure) => {
    const h = await recovery()
    const observed = await h.session.observeRecovery()
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    const original = h.fake.rawDraft(DRAFT_KEY)
    if (failure === 'quota')
      h.fake.failNext('adoptObserved', { kind: 'quota' })
    else
      await h.fake.store.registerWriter(DRAFT_KEY, { writeEpoch: 4, writerId: 'newer' }, { now: NOW, force: false })
    const source = createPersistentWorkingDraft({ ...h.options, recoveryObservation: observed.observation })
    const ref = initialRef(source)
    expect(await source.ready(ref)).toMatchObject({ local: { kind: 'memory', reason: failure === 'quota' ? 'quota' : 'fenced' } })
    expect(await source.readLatest()).toMatchObject({ snapshot: INITIAL.snapshot })
    expect(h.fake.rawDraft(DRAFT_KEY)).toEqual(original)
    const next = source.capture({ snapshot: '后续内存内容', editorSeq: 1, formulasPending: false, dedupe: true })
    expect(await source.ready(next)).toMatchObject({ local: { kind: 'memory' } })
    expect(h.fake.calls.filter(call => call === 'adoptObserved')).toHaveLength(1)
    expect(h.fake.rawDraft(DRAFT_KEY)).toEqual(original)
    source.dispose()
  })

  it('首份接手在途时的新捕获仍按来源队列处理，接手只发生一次且最终正文是最新输入', async () => {
    const h = await recovery()
    const observed = await h.session.observeRecovery()
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    const held = h.fake.holdNext('adoptObserved')
    const source = createPersistentWorkingDraft({ ...h.options, recoveryObservation: observed.observation })
    await held.reached
    const next = source.capture({ snapshot: '接手期间排队的新内容', editorSeq: 1, formulasPending: false, dedupe: true })
    held.release()
    expect(await source.ready(next)).toMatchObject({ contentSeq: 92, local: { kind: 'persisted' } })
    expect(await source.readLatest()).toMatchObject({ snapshot: '接手期间排队的新内容' })
    expect(h.fake.calls.filter(call => call === 'adoptObserved')).toHaveLength(1)
    expect(h.fake.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 92 })
    source.dispose()
  })

  it('关闭新写时内存恢复不登记/接手/删除；独立只读宿主在实际确认后仍可条件清理原件', async () => {
    const h = await recovery(false)
    expect(h.host).not.toHaveBeenCalled()
    const readOnly = createDraftWriter({ store: h.fake.store, now: () => NOW })
    await readOnly.setKey(h.key)
    const observed = await readOnly.observe(DRAFT_KEY)
    if (observed.kind !== 'observed')
      throw new Error('关闭新写不应阻止观察')
    const original = h.fake.rawDraft(DRAFT_KEY)
    const registrations = h.fake.calls.filter(call => call === 'registerWriter').length
    const source = createMemoryWorkingDraft({ ...DRAFT_OPTIONS, initialDraftSeq: 90, reason: 'disabled', initialCapture: INITIAL })
    const ref = initialRef(source)
    const prepared = await source.prepare(ref)
    if (prepared.kind !== 'prepared')
      throw new Error('缺少内存内容')
    expect(h.fake.rawDraft(DRAFT_KEY)).toEqual(original)
    expect(await source.confirm(prepared, 9)).toEqual({ kind: 'memory', reason: 'disabled' })
    expect(h.fake.rawDraft(DRAFT_KEY)).toEqual(original)
    expect(await readOnly.removeObserved(observed.observation)).toMatchObject({ kind: 'removed' })
    expect(h.fake.rawDraft(DRAFT_KEY)).toBeUndefined()
    expect(h.fake.calls.filter(call => call === 'registerWriter')).toHaveLength(registrations)
    expect(h.fake.calls).not.toContain('adoptObserved')
    source.dispose()
    h.session.dispose()
    readOnly.dispose()
  })
})
