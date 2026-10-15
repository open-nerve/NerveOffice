import type { RefObject } from 'react'
import { useEffect, useRef } from 'react'
import { useBlocker } from 'react-router'
import { localDraftsMessages as text } from '../../shared/i18n/zh-cn/local-drafts.ts'
import { ConfirmDialog } from '../confirmation/index.ts'

/** 只保住本页未知副本的核对机会；离开本身不删除任何草稿。 */
export function DraftLeaveGuard({ active, fallback }: { readonly active: boolean, readonly fallback: RefObject<HTMLElement | null> }) {
  const blocker = useBlocker(active)
  const leavingRef = useRef(false)
  useEffect(() => {
    if (!active)
      return undefined
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [active])
  return (
    <ConfirmDialog
      pending={blocker.state !== 'blocked'
        ? undefined
        : {
            title: text.leaveTitle,
            description: text.leaveDescription,
            confirmLabel: text.leaveConfirm,
            run: async () => {
              leavingRef.current = true
              blocker.proceed()
            },
            refresh: async () => {},
            returnFocus: () => fallback.current?.focus(),
          }}
      onClose={() => {
        if (!leavingRef.current)
          blocker.reset?.()
      }}
    />
  )
}
