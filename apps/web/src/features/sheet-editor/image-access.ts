import type { SessionResponse } from '@nerve-office/contracts'
import type { EditorImageAccess } from '../../editor/index.ts'

export interface EditorImageAccessController extends EditorImageAccess {
  readonly confirm: (session: SessionResponse) => void
  readonly refresh: () => void
  readonly suspend: () => void
  readonly dispose: () => void
}

export function createEditorImageAccess(owner: string): EditorImageAccessController {
  let current: SessionResponse | undefined
  let disposed = false
  const listeners = new Set<() => void>()
  function notify(): void {
    for (const listener of [...listeners])
      listener()
  }
  function suspend(): void {
    if (current === undefined)
      return
    current = undefined
    notify()
  }
  return {
    owner,
    current: () => current,
    subscribe: (listener) => {
      if (!disposed)
        listeners.add(listener)
      return () => listeners.delete(listener)
    },
    confirm: (session) => {
      if (disposed)
        return
      if (session.user.id !== owner) {
        suspend()
        return
      }
      const changed = current?.csrfToken !== session.csrfToken
      current = session
      if (changed)
        notify()
    },
    refresh: () => {
      if (current !== undefined)
        notify()
    },
    suspend,
    dispose: () => {
      disposed = true
      suspend()
      listeners.clear()
    },
  }
}
