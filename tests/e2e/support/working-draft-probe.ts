import type { Page } from '@playwright/test'
import type { DraftKey, InFlightSave } from './outbox-probe.ts'
import type { SessionFact } from './outbox-session-probe.ts'

interface CaptureRef {
  readonly serial: number
  readonly draftSeq: number
  readonly editorSeq: number
}

export interface WorkingDraftProbe {
  readonly create: (input: { readonly draft: DraftKey, readonly mode: 'worker' | 'initial-failure' | 'memory' }) => Promise<{ readonly id: number, readonly result: SessionFact }>
  readonly capture: (id: number, snapshot: string, editorSeq: number, dedupe?: boolean) => CaptureRef
  readonly ready: (id: number, serial: number) => Promise<SessionFact>
  readonly prepare: (id: number, serial: number) => Promise<SessionFact>
  readonly release: (id: number) => void
  readonly markInFlight: (id: number, inFlight: InFlightSave) => Promise<SessionFact>
  readonly confirm: (id: number, revision: number) => Promise<SessionFact>
  readonly readLatest: (id: number) => Promise<SessionFact>
  readonly view: (id: number) => SessionFact
  readonly setKey: (id: number, source: 'probe' | 'none') => Promise<SessionFact>
  readonly suspend: (id: number) => void
  readonly resume: (id: number) => Promise<SessionFact>
  readonly terminate: (id: number) => void
  readonly startRead: (id: number) => void
  readonly readResult: (id: number) => Promise<SessionFact | undefined>
  readonly counts: (id: number) => { readonly keys: number, readonly hosts: number, readonly confirmations: number }
  readonly disposeAll: () => void
}

export async function probeWorking<M extends keyof WorkingDraftProbe>(page: Page, method: M, ...args: Parameters<WorkingDraftProbe[M]>): Promise<Awaited<ReturnType<WorkingDraftProbe[M]>>> {
  return page.evaluate(async ({ method, args }) => {
    const target = window.__nerveOutboxProbe
    if (target === undefined)
      throw new Error('页面里没有发件箱的探针')
    return (target.working[method] as unknown as (...values: unknown[]) => unknown)(...args)
  }, { method, args }) as Promise<Awaited<ReturnType<WorkingDraftProbe[M]>>>
}
