// 编辑器就绪之前的交互屏障（Codex 评审 CX1，独立复验 N1）：表格已经画出来、保存与离开提示还没接上时，
// 页头之外的用户输入（点击、悬停、键入、输入法、粘贴与拖放）一律拦下。这时的输入既存不了，加载超时销毁编辑器时还会随之丢失。
// - 按"只放行页头"判断，不按"只拦编辑器的容器"：Univer 的浮层（批注、链接、菜单等）挂在 document.body 下新建的容器里，
//   不在编辑器的容器里（ui 的 Workbench.tsx），悬停就会弹出、在浮层里就能改内容；
// - 悬停也拦：浮层不弹出来，用户不会以为已经可以编辑；
// - 不能靠 SDK 的"不可编辑"兜底：SDK 在 Ready 时、用户变化时按授权服务初始化权限点，编辑器身份的授权服务一律允许
//   （ADR-009），更早设的不可编辑会被改回来（sheets 的 sheet-permission-init.controller.ts）；
// - 不用 inert：它让 Univer 初始化时把焦点放进输入框失败，就绪之后点当前的单元格也不会再放（选区没变，
//   editor-bridge.render-controller.ts 的 isSameEditCell），键入就进不去了。这里只拦事件，焦点事件不拦；
// - 浏览器的刷新（F5、Ctrl/Cmd+R）与 Tab 照常：它们不改内容，加载卡住时要能刷新，键盘用户要能到页头。
// 在窗口的捕获阶段监听，并在创建编辑器之前挂上：排在 SDK 自己挂在窗口上的监听（快捷键）之前，拦下的事件它们都收不到。

/** 用户的输入：指针与鼠标（含悬停）、触摸、键盘、文本输入与输入法、剪贴板、拖放（滚轮与焦点不拦） */
const USER_INPUT_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointerover',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseover',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
  'touchmove',
  'touchend',
  'keydown',
  'keypress',
  'keyup',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'paste',
  'cut',
  'dragstart',
  'dragenter',
  'dragover',
  'drop',
] as const

/** 不拦的按键：刷新（F5，Ctrl/Cmd+R，可以带 Shift）与 Tab（可以带 Shift） */
function isBrowserNavigationKey(event: Event): boolean {
  if (!(event instanceof KeyboardEvent))
    return false
  if (event.key === 'F5' || event.key === 'Tab')
    return !event.altKey && !event.ctrlKey && !event.metaKey
  return event.key.toLowerCase() === 'r' && (event.ctrlKey || event.metaKey) && !event.altKey
}

/**
 * 挂上屏障：目标不在 interactive（页头）里的用户输入一律取消、不再传递。返回撤掉它的函数（可以重复调用）
 */
export function blockInteractions(interactive: HTMLElement, target: Pick<Window, 'addEventListener' | 'removeEventListener'> = interactive.ownerDocument.defaultView ?? window): () => void {
  const block = (event: Event): void => {
    if (event.target instanceof Node && interactive.contains(event.target))
      return
    if (isBrowserNavigationKey(event))
      return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  // passive 显式为 false：挂在窗口上的触摸监听，浏览器默认按 passive 处理，取消不了默认行为
  for (const type of USER_INPUT_EVENTS)
    target.addEventListener(type, block, { capture: true, passive: false })
  let released = false
  return () => {
    if (released)
      return
    released = true
    for (const type of USER_INPUT_EVENTS)
      target.removeEventListener(type, block, { capture: true })
  }
}
