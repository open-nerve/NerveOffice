import type { EstimateOutcome, PersistedState, PersistOutcome } from '../../shared/outbox/storage-status.ts'
import { useEffect, useId, useRef, useState } from 'react'
import { localDraftsMessages } from '../../shared/i18n/zh-cn/local-drafts.ts'
import { requestPersistence, storageEstimate, storagePersisted } from '../../shared/outbox/storage-status.ts'
import { Button } from '../../shared/ui/index.ts'
import { StatusRegion } from '../../shared/ui/status-region.tsx'

const text = localDraftsMessages.storage
const FAILED = { kind: 'failed', error: { name: 'StorageStatus', message: '无法取得存储状态' } } as const

function bytes(value: number | undefined): string {
  if (value === undefined)
    return text.unknown
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = Math.min(value === 0 ? 0 : Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scale = Math.max(0, index)
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value / 1024 ** scale)} ${units[scale]}`
}

export function StorageStatus() {
  const id = useId()
  const mountedRef = useRef(false)
  const permissionVersionRef = useRef(0)
  const pendingRef = useRef(false)
  const [persisted, setPersisted] = useState<PersistedState>()
  const [estimate, setEstimate] = useState<EstimateOutcome>()
  const [requesting, setRequesting] = useState(false)
  const [result, setResult] = useState<PersistOutcome>()
  useEffect(() => {
    mountedRef.current = true
    let alive = true
    const version = permissionVersionRef.current
    const permissionReady = (value: PersistedState) => {
      if (alive && version === permissionVersionRef.current)
        setPersisted(value)
    }
    const estimateReady = (value: EstimateOutcome) => {
      if (alive)
        setEstimate(value)
    }
    // 两个查询独立落到界面；任一个未返回时不扣住另一个已知事实。
    void storagePersisted().then(permissionReady, () => permissionReady(FAILED))
    void storageEstimate().then(estimateReady, () => estimateReady(FAILED))
    return () => {
      alive = false
      mountedRef.current = false
    }
  }, [])

  async function request(): Promise<void> {
    if (pendingRef.current || !mountedRef.current)
      return
    pendingRef.current = true
    setRequesting(true)
    try {
      // 在点击的同步段申请，保留浏览器识别到的用户动作。
      const outcome = await requestPersistence()
      if (mountedRef.current) {
        setResult(outcome)
        if (outcome.kind === 'granted') {
          permissionVersionRef.current += 1
          setPersisted({ kind: 'persisted' })
        }
      }
    }
    catch {
      if (mountedRef.current)
        setResult(FAILED)
    }
    finally {
      pendingRef.current = false
      if (mountedRef.current)
        setRequesting(false)
    }
  }

  const permission = persisted === undefined ? text.loading : persisted.kind === 'persisted' ? text.granted : persisted.kind === 'not-persisted' ? text.notGranted : text.unknown
  const usage = estimate === undefined ? text.loading : bytes(estimate.kind === 'estimated' ? estimate.usage : undefined)
  const quota = estimate === undefined ? text.loading : bytes(estimate.kind === 'estimated' ? estimate.quota : undefined)
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-lg border p-4">
      <h2 id={id} className="font-medium">{text.title}</h2>
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        {[[text.persisted, permission], [text.usage, usage], [text.quota, quota]].map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{text.scope}</p>
      <p className="text-xs text-muted-foreground">{text.limitation}</p>
      <Button variant="outline" size="sm" aria-disabled={requesting} aria-busy={requesting} onClick={() => void request()}>{requesting ? text.requesting : text.request}</Button>
      <StatusRegion className="text-sm text-muted-foreground" keepFocusInView>{result === undefined ? undefined : text.requested[result.kind]}</StatusRegion>
    </section>
  )
}
