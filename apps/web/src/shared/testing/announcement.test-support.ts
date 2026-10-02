// 测试用：做完一件事的说明写进页面的那一刻（M2-P5 复验 S1）。确认的弹窗开着时 Radix 把弹窗之外的内容都标为 aria-hidden，
// 那时写进状态区、插入说明条或提示的文字，读屏多半不播报；共用的确认弹窗（features/confirmation）等自己关掉、焦点交还之后才执行
// run 交回的说明。这里记下一段说明第一次出现在状态区（role="status"）或提示（role="alert"）里的那一刻的样子：
// MutationObserver 在 DOM 变了之后的第一个微任务里记下，那时的样子就是写进去那一刻的样子。真实浏览器里的同一项核对在 E2E
// （tests/e2e/support/status-writes.ts）。

/** 说明第一次出现那一刻的样子 */
export interface Announcement {
  /** 它所在的状态区或提示在 aria-hidden 之下（自己或祖先带 aria-hidden="true"）：读屏多半不播报 */
  readonly ariaHidden: boolean
  /**
   * 焦点已经交还：不在 body 上，也不在别的对话框里（例如还开着的确认框；说明自己就在对话框里时，焦点在同一个对话框里算）。
   * 只看 aria-hidden 分不出"与关掉同一次渲染写进去"：那时 Radix 的撤销可能已经执行，确认框连同有焦点的按钮却刚被移走，
   * 焦点在 body 上，交还焦点还在后面
   */
  readonly focusReturned: boolean
}

/** 焦点已经交还（见 Announcement 的 focusReturned） */
function focusReturnedFor(region: Element): boolean {
  const active = document.activeElement
  if (active === null || active === document.body)
    return false
  const dialog = active.closest('[role="dialog"], [role="alertdialog"]')
  return dialog === null || dialog.contains(region)
}

/**
 * 从现在起等这段说明出现在某个状态区或提示里（文字包含 text）。返回取结果的函数：还没出现时是 undefined；
 * 出现之后不再记（之后的变化不改第一次的结果）
 */
export function watchAnnouncement(text: string): () => Announcement | undefined {
  let seen: Announcement | undefined
  const observer = new MutationObserver(() => {
    const region = [...document.querySelectorAll('[role="status"], [role="alert"]')].find(element => element.textContent.includes(text))
    if (region === undefined)
      return
    seen = { ariaHidden: region.closest('[aria-hidden="true"]') !== null, focusReturned: focusReturnedFor(region) }
    observer.disconnect()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => seen
}
