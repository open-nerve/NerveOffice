import type { DraftMaintenanceView } from '../../shared/local-drafts/draft-maintenance.ts'
import type { NoticeRuntime } from './notice-runtime.ts'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { LOCAL_DRAFTS_PATH } from '../../shared/lib/local-drafts-path.ts'
import { Button, buttonVariants } from '../../shared/ui/index.ts'

const EMPTY: DraftMaintenanceView = { busy: false, cleanup: 'idle', retention: 'idle', problem: undefined, catalog: undefined }
const idleView = () => EMPTY
const idleSubscribe = () => () => {}

/** 背景结果只播报，不自动获取焦点；重试按钮被聚焦后保留，避免完成时把焦点扔到 body。 */
export function LocalDataStatus({ runtime }: { readonly runtime: NoticeRuntime | undefined }) {
  const state = useSyncExternalStore(runtime?.model.subscribe ?? idleSubscribe, runtime?.model.view ?? idleView)
  const [keepAction, setKeepAction] = useState(false)
  const message = runtime?.describe(state)
  const text = runtime?.text
  const shown = message !== undefined || keepAction
  return (
    <div className={shown ? 'flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/30 px-4 py-2 text-sm' : undefined}>
      <p role="status" className={shown ? undefined : 'sr-only'}>{message ?? (keepAction ? state.busy ? text?.maintenanceChecking : text?.maintenanceDone : undefined)}</p>
      {shown && (
        <Button
          variant="outline"
          size="sm"
          aria-disabled={state.busy}
          onFocus={() => setKeepAction(true)}
          onClick={() => {
            if (runtime !== undefined && !runtime.model.view().busy) {
              setKeepAction(true)
              void runtime.model.retry()
            }
          }}
        >
          {text?.maintenanceRetry}
        </Button>
      )}
      {message !== undefined && state.catalog !== undefined && <a href={LOCAL_DRAFTS_PATH} className={buttonVariants({ variant: 'link', size: 'sm' })}>{text?.maintenanceDetails}</a>}
    </div>
  )
}

export function LocalDataNotice() {
  const [runtime, setRuntime] = useState<NoticeRuntime>()
  useEffect(() => {
    let alive = true
    let dispose: (() => void) | undefined
    void import('./notice-runtime.ts').then(({ mountNoticeRuntime }) => {
      if (!alive)
        return
      const mounted = mountNoticeRuntime()
      dispose = mounted.dispose
      setRuntime(mounted)
    }).catch(() => {})
    return () => {
      alive = false
      dispose?.()
    }
  }, [])
  return <LocalDataStatus runtime={runtime} />
}
