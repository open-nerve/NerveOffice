/** 平台只静态带上这段加载约定；维护失败不阻塞阅读或公开链接。 */
export function startDraftMaintenance(onIdle?: () => void): () => void {
  let disposed = false
  let stop: (() => void) | undefined
  void import('../local-drafts/browser-maintenance.ts').then(({ mountBrowserMaintenance }) => {
    if (disposed)
      return
    const mounted = mountBrowserMaintenance()
    const observe = () => {
      if (!mounted.model.view().busy)
        onIdle?.()
    }
    const unsubscribe = onIdle === undefined ? undefined : mounted.model.subscribe(observe)
    stop = () => {
      unsubscribe?.()
      mounted.dispose()
    }
    // 列表可能晚于维护挂载；已经完成的清理也需要重新读取索引。
    if (onIdle !== undefined)
      observe()
  }).catch(() => { /* 当前页仍可使用；重新打开后重试加载维护模块。 */ })
  return () => {
    if (disposed)
      return
    disposed = true
    stop?.()
  }
}
