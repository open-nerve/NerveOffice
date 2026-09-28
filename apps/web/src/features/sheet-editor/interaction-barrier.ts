// 编辑器就绪之前的交互屏障（Codex 评审 CX1）：表格已经画出来、保存与离开提示还没接上时，容器里的点击、键入、输入法、
// 粘贴与拖放一律拦下。这时的输入既存不了，加载超时销毁编辑器时还会随之丢失；编辑器本身也在就绪之前不能编辑（sheet-editor.ts），
// 屏障让用户碰不到它，不会撞上 SDK 的"没有编辑权限"提示。
// 不用 inert：容器不可交互时 Univer 在初始化时把焦点放进它的输入框会失败，就绪之后点当前的单元格也不会再放（选区没变，
// editor-bridge.render-controller.ts 的 isSameEditCell），键入就进不去了。这里只拦事件，焦点照常。
// 在窗口的捕获阶段监听，并在创建编辑器之前挂上：排在 SDK 自己挂在窗口上的监听（快捷键）之前，拦下的事件它们都收不到。
// 只拦目标在容器里的事件：页头（返回、保存按钮）照常可以操作。

/** 用户的输入：指针与鼠标、触摸、键盘、文本输入与输入法、剪贴板、拖放（悬停与滚轮不改内容，不拦） */
const USER_INPUT_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
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
  'dragenter',
  'dragover',
  'drop',
] as const

/** 挂上屏障，返回撤掉它的函数（可以重复调用） */
export function blockInteractions(surface: HTMLElement, target: Pick<Window, 'addEventListener' | 'removeEventListener'> = surface.ownerDocument.defaultView ?? window): () => void {
  const block = (event: Event): void => {
    if (event.target instanceof Node && surface.contains(event.target)) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
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
