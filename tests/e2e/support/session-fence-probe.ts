import type { Page } from '@playwright/test'
import type { ProbeProblem, ProbeStoreOptions } from './outbox-probe.ts'

export interface SessionSource { readonly userId: string, readonly sourceHash: string }
export interface SessionTicket { readonly kind: 'query' | 'mutation', readonly generation: string }
export interface SessionPermit { readonly userId: string, readonly generation: string }
export interface CleanupPermit extends SessionPermit { readonly cause: 'logout' | 'account_disabled' }
type Result<T> = Promise<T | ProbeProblem | { readonly kind: 'session-invalid' }>

export interface SessionFenceProbe {
  readonly read: () => Result<{ readonly kind: 'state', readonly state: Readonly<Record<string, unknown>> | undefined }>
  readonly begin: (kind: SessionTicket['kind']) => Result<{ readonly kind: 'ticket', readonly ticket: SessionTicket }>
  readonly accept: (ticket: SessionTicket, source: SessionSource) => Result<{ readonly kind: 'active', readonly permit: SessionPermit }>
  readonly fail: (ticket: SessionTicket) => Result<{ readonly kind: 'released' }>
  readonly suspend: (permit: SessionPermit) => Result<{ readonly kind: 'suspended' }>
  readonly beginCleanup: (permit: SessionPermit, cause: CleanupPermit['cause']) => Result<{ readonly kind: 'clearing', readonly permit: CleanupPermit }>
  readonly finishCleanup: (permit: CleanupPermit) => Result<{ readonly kind: 'cleared' }>
  readonly advance: (milliseconds: number) => void
  readonly reset: (options?: ProbeStoreOptions) => void
  readonly close: () => void
}

export async function fence<M extends keyof SessionFenceProbe>(page: Page, method: M, ...args: Parameters<SessionFenceProbe[M]>): Promise<Awaited<ReturnType<SessionFenceProbe[M]>>> {
  return page.evaluate(async ({ method, args }) => {
    const target = window.__nerveOutboxProbe
    if (target === undefined)
      throw new Error('页面里没有发件箱的探针')
    return (target.fence[method] as unknown as (...values: unknown[]) => unknown)(...args)
  }, { method, args }) as Promise<Awaited<ReturnType<SessionFenceProbe[M]>>>
}
