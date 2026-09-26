// 编辑器页的快捷键与离开提示（P4 设计 §3.7.3）。

/** 苹果的平台用 Cmd，其他平台用 Ctrl（按真实平台判断，不看浏览器） */
export function isApplePlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}

/** Ctrl+S（苹果的平台是 Cmd+S）：不带别的修饰键，输入法组字时不算。 */
export function isSaveShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>, apple: boolean): boolean {
  const [modifier, other] = apple ? [event.metaKey, event.ctrlKey] : [event.ctrlKey, event.metaKey]
  return modifier && !other && !event.altKey && !event.shiftKey && !event.isComposing && event.key.toLowerCase() === 's'
}

export interface GuardedPage {
  readonly save: () => Promise<void>
  readonly hasUnsavedWork: () => boolean
}

/**
 * 在捕获阶段监听保存的快捷键（Univer 没有绑定它；焦点在单元格编辑器里也收得到），阻止浏览器的"另存网页"；
 * 有未保存的修改时，关闭或离开页面由浏览器弹出提示。不把关页时的异步请求当作保存（计划书 §7.8）。
 * 返回撤销监听的函数。
 */
export function installPageGuards(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, page: GuardedPage, apple: boolean): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isSaveShortcut(event, apple))
      return
    event.preventDefault()
    void page.save()
  }
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (page.hasUnsavedWork())
      event.preventDefault()
  }
  target.addEventListener('keydown', onKeyDown, { capture: true })
  target.addEventListener('beforeunload', onBeforeUnload)
  return () => {
    target.removeEventListener('keydown', onKeyDown, { capture: true })
    target.removeEventListener('beforeunload', onBeforeUnload)
  }
}
