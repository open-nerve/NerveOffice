import type { Autosave } from './autosave.ts'
import type { EditLease, LeaseVerdict } from './edit-lease.ts'
import type { EditingSessionEditor, EditingSessionOptions } from './editing-session.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditingSession } from './editing-session.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { fakeLeaseServer } from './lease-server.test-support.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { sameBrowserFor } from './same-browser.ts'

const USER = { id: 'user-1', username: 'amy', displayName: '艾米' }
const DOCUMENT = 'document-1'
const SAVED = { revision: 4, savedAt: '2026-10-10T03:00:00.000Z', unchanged: false }
const cleanup: (() => void)[] = []

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse())
    dispose()
})

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function editorFixture() {
  let seq = 0
  const changes = new Set<() => void>()
  const input = new Set<() => void>()
  const formulas = new Set<() => void>()
  const composition = new Set<() => void>()
  const listen = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const editor: EditingSessionEditor = {
    changeSeq: () => seq,
    onChange: listen(changes),
    uncommittedInput: () => 'none',
    onUncommittedInputChange: listen(input),
    formulasSettled: () => true,
    onFormulaProgress: listen(formulas),
    composing: () => false,
    onCompositionChange: listen(composition),
    isCellEditing: () => false,
    commitCellEditing: async () => true,
    settlePanels: async () => {},
    settleFormulas: async () => 'settled',
    capture: () => `{"v":${seq}}`,
  }
  return {
    editor,
    edit: () => {
      seq += 1
      changes.forEach(listener => listener())
    },
    listeners: () => changes.size + input.size + formulas.size + composition.size,
  }
}

function leaseFixture() {
  return {
    credentials: () => ({ token: 'token-1', writeEpoch: 7 }),
    pause: vi.fn(),
    resume: vi.fn(async () => {}),
    lose: vi.fn(async () => ({ kind: 'held' } as const)),
    noteActivity: vi.fn(),
    holdRecovery: vi.fn(),
    allowRecovery: vi.fn(),
    confirm: vi.fn(async (): Promise<LeaseVerdict> => ({ kind: 'current' })),
    abandon: vi.fn(),
    release: vi.fn(async () => true),
  } satisfies EditLease
}

function fixture() {
  const time = fakeLeaseClock()
  const browser = fakeBrowser()
  const sameBrowser = sameBrowserFor(DOCUMENT, browser.tab('page-1'))
  const other = sameBrowserFor(DOCUMENT, browser.tab('page-2'))
  const server = fakeLeaseServer(USER)
  const pageListeners = new Set<() => void>()
  const attach = vi.fn<(scheduler: Autosave | undefined) => void>()
  const options: EditingSessionOptions = {
    documentId: DOCUMENT,
    clientInstanceId: 'page-1',
    api: {
      editLease: { ...server.api, handOver: async () => { throw new Error('本用例不交出') }, decline: async () => {} },
      compress: async text => new TextEncoder().encode(text),
      save: vi.fn(async () => SAVED),
    },
    clock: time.clock,
    sameBrowser,
    lastActivity: time.now,
    newId: () => 'request-1',
    session: { saveUnauthenticated: vi.fn(), saveStale: vi.fn(), writeProblem: vi.fn() },
    autosave: {
      page: {
        visible: () => true,
        online: () => true,
        sessionWritable: () => true,
        onChange: (listener) => {
          pageListeners.add(listener)
          return () => {
            pageListeners.delete(listener)
          }
        },
      },
      digest: async () => 'digest',
      attach,
    },
    reportError: vi.fn(),
    onLost: vi.fn(),
    onIncompatible: vi.fn(),
    onRequest: vi.fn(),
    onChange: vi.fn(),
  }
  const session = createEditingSession(options)
  cleanup.push(sameBrowser.close, other.close, session.dispose)
  return { session, options, time, other, pageListeners, attach }
}

const INITIAL = { revision: 3, snapshotBytes: 7, formulasPending: false, blocked: undefined }

describe('编辑会话的资源所有权', () => {
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

  it('观察者 attach 时协调器与调度都已可读；重复停止会清净订阅且只分离一次', () => {
    const { session, options, pageListeners, attach } = fixture()
    const page = editorFixture()
    session.acceptLease(leaseFixture(), 3)
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
    session.acceptLease(leaseFixture(), 3)
    session.startSaving(page.editor, INITIAL)
    page.edit()
    const saving = session.coordinator
    if (saving === undefined)
      throw new Error('保存协调未建立')
    const outcome = saving.save(() => ({ seq: 1, snapshot: '{"v":1}', bytes: 7, formulasPending: false, digest: undefined }), { dedupe: false })
    await settle()
    expect(options.api.save).toHaveBeenCalledTimes(1)
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
    expect(options.api.save).toHaveBeenCalledWith(DOCUMENT, expect.objectContaining({ baseRevision: 9 }), new TextEncoder().encode('{"v":1}'), next.credentials())
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
