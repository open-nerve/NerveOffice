import type { Page } from '@playwright/test'
import type { DraftKey, InFlightSave } from './outbox-probe.ts'

export interface SessionFact {
  readonly kind: string
  readonly [field: string]: unknown
}

export interface OutboxSessionProbe {
  readonly create: (options: { readonly draft: DraftKey, readonly epoch: number, readonly mode?: 'worker' | 'initial-failure' | 'disabled' | 'no-locks' | 'no-key' }) => Promise<{ readonly id: number, readonly result: SessionFact }>
  readonly write: (id: number, draftSeq: number, text: string, inFlight?: InFlightSave | null) => Promise<SessionFact>
  readonly read: (id: number) => Promise<SessionFact>
  readonly startRead: (id: number) => void
  readonly readResult: (id: number) => Promise<SessionFact | undefined>
  readonly markInFlight: (id: number, inFlight: InFlightSave) => Promise<SessionFact>
  readonly confirm: (id: number, draftSeq: number, revision: number) => Promise<SessionFact>
  readonly setKey: (id: number, source: 'probe' | 'none') => Promise<SessionFact>
  readonly suspend: (id: number) => void
  readonly resume: (id: number) => Promise<SessionFact>
  readonly state: (id: number) => SessionFact
  readonly counts: (id: number) => { readonly keys: number, readonly hosts: number, readonly persists: number, readonly confirmations: number }
  readonly terminate: (id: number) => void
  readonly dispose: (id: number) => void
  readonly disposeAll: () => void
}

export async function probeSession<M extends keyof OutboxSessionProbe>(page: Page, method: M, ...args: Parameters<OutboxSessionProbe[M]>): Promise<Awaited<ReturnType<OutboxSessionProbe[M]>>> {
  return page.evaluate(async ({ method, args }) => {
    const target = window.__nerveOutboxProbe
    if (target === undefined)
      throw new Error('页面里没有发件箱的探针')
    return (target.session[method] as unknown as (...values: unknown[]) => unknown)(...args)
  }, { method, args }) as Promise<Awaited<ReturnType<OutboxSessionProbe[M]>>>
}
