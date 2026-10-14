import { useEffect, useState } from 'react'

const EMPTY: ReadonlySet<string> = new Set()

/** 每个列表只读一次本人的键；没有标题、正文、密钥或网络依赖。 */
export function useDraftMarkers(userId: string | undefined): ReadonlySet<string> {
  const [state, setState] = useState<{ readonly userId: string, readonly ids: ReadonlySet<string> }>()
  useEffect(() => {
    if (userId === undefined)
      return
    const ownerId = userId
    let alive = true
    let sequence = 0
    async function read(): Promise<void> {
      const ticket = ++sequence
      let ids = EMPTY
      try {
        const index = await import('../outbox/draft-index.ts')
        if (!alive)
          return
        ids = await index.draftDocumentIds(ownerId)
      }
      catch {
        // 标记只是提示：无法读取时仍可使用文档列表。
      }
      if (alive && sequence === ticket)
        setState({ userId: ownerId, ids })
    }
    const visible = () => {
      if (document.visibilityState === 'visible')
        void read()
    }
    void read()
    window.addEventListener('focus', visible)
    window.addEventListener('pageshow', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      alive = false
      window.removeEventListener('focus', visible)
      window.removeEventListener('pageshow', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [userId])
  return state?.userId === userId ? state?.ids ?? EMPTY : EMPTY
}
