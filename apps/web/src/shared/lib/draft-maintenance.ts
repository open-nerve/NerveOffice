/** 平台只静态带上这段加载约定；维护失败不阻塞阅读或公开链接。 */
export function startDraftMaintenance(): () => void {
  let disposed = false
  let stop: (() => void) | undefined
  void import('../local-drafts/browser-maintenance.ts').then(({ mountBrowserMaintenance }) => {
    if (!disposed)
      stop = mountBrowserMaintenance().dispose
  }).catch(() => { /* 当前页仍可使用；重新打开后重试加载维护模块。 */ })
  return () => {
    if (disposed)
      return
    disposed = true
    stop?.()
  }
}
