// 编辑会话的单元与连接交错共用装配；每个测试文件在 afterEach 调用 disposeSessions。
import type { Autosave } from './autosave.ts'
import type { EditLease, LeaseVerdict } from './edit-lease.ts'
import type { EditingSessionEditor, EditingSessionOptions } from './editing-session.ts'
import { vi } from 'vitest'
import { fakeDraftStore } from '../../shared/outbox/draft-store.test-support.ts'
import { createDraftWriter } from '../../shared/outbox/draft-writer.ts'
import { createLocalKeyKeeper } from '../../shared/outbox/local-key.ts'
import { createEditingSession } from './editing-session.ts'
import { fakeLeaseClock } from './fake-lease-clock.test-support.ts'
import { fakeLeaseServer } from './lease-server.test-support.ts'
import { newKey } from './outbox/persistent-working-draft.test-support.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { sameBrowserFor } from './same-browser.ts'

export const USER = { id: 'user-1', username: 'amy', displayName: '艾米' }
export const DOCUMENT = 'document-1'
export const SAVED = { revision: 4, savedAt: '2026-10-10T03:00:00.000Z', unchanged: false }
const cleanup: (() => void)[] = []

export function disposeSessions(): void {
  for (const dispose of cleanup.splice(0).reverse())
    dispose()
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export function editorFixture() {
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

export function leaseFixture() {
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

export function fixture(overrides: Partial<EditingSessionOptions> = {}) {
  const time = fakeLeaseClock()
  const browser = fakeBrowser()
  const sameBrowser = sameBrowserFor(DOCUMENT, browser.tab('page-1'))
  const other = sameBrowserFor(DOCUMENT, browser.tab('page-2'))
  const server = fakeLeaseServer(USER)
  const pageListeners = new Set<() => void>()
  const attach = vi.fn<(scheduler: Autosave | undefined) => void>()
  const options: EditingSessionOptions = {
    userId: USER.id,
    documentId: DOCUMENT,
    clientInstanceId: 'page-1',
    api: {
      editLease: { ...server.api, handOver: async () => { throw new Error('本用例不交出') }, decline: async () => {} },
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
      attach,
    },
    reportError: vi.fn(),
    onLost: vi.fn(),
    onIncompatible: vi.fn(),
    onRequest: vi.fn(),
    onChange: vi.fn(),
    ...overrides,
  }
  const session = createEditingSession(options)
  cleanup.push(sameBrowser.close, other.close, session.dispose)
  return { session, options, time, other, pageListeners, attach }
}

export const INITIAL = { revision: 3, snapshotBytes: 7, formulasPending: false, blocked: undefined }

export async function prepare(session: ReturnType<typeof createEditingSession>, held: EditLease = leaseFixture(), revision = INITIAL.revision) {
  session.acceptLease(held, revision)
  await session.claim(held)
  return session.prepareDraft({ revision })
}

export async function localDrafts() {
  const key = await newKey(1)
  const store = fakeDraftStore()
  const keeper = createLocalKeyKeeper({ fetch: async () => key, clock: fakeLeaseClock().clock, retry: { initialMs: 2_000, maxMs: 30_000 }, requestTimeoutMs: 10_000 })
  const host = vi.fn(async () => {
    const writer = createDraftWriter({ store: store.store, now: Date.now })
    let broken = false
    return { kind: 'in-process' as const, writer, broken: () => broken, dispose: () => {
      broken = true
      writer.dispose()
    } }
  })
  return { store, host, options: { enabled: () => true, keeper, host, supported: () => true, persist: async () => ({ kind: 'denied' as const }) } }
}
