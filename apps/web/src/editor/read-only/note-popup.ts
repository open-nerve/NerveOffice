// 只读时批注浮层的文本框设为只读（M2-P3 S3 的 E2E 发现之后）：sheets-note-ui 的批注浮层总是可以输入的文本框
// （views/Note.tsx:156-158，没有只读的开关，打开时还会被程序聚焦，:98-106）。只读时在里面键入，离开时写回批注的 mutation 虽然被
// 防火墙取消、界面随之复原，但看起来像是能改。这里在页面上观察这个文本框出现，给它设 readOnly：文字照常显示，可以选中、复制。
// 浮层经 SDK 的弹出层渲染，挂在哪里由 SDK 决定，所以观察整个 body（一页只有一个编辑器）。
// 找元素用的是 SDK 的 DOM 标记（internal-api 的 NOTE_TEXTAREA_SELECTOR，已登记）。React 不管 readOnly（组件没有传这个属性），
// 设上之后重新渲染也不会被改回；浮层关掉再打开是新的元素，观察者再设一次
import { NOTE_TEXTAREA_SELECTOR } from '../internal-api/index.ts'

/** 把 scope（元素本身与它的后代）里的批注文本框设为只读 */
function lockIn(scope: Element): void {
  if (scope.matches(NOTE_TEXTAREA_SELECTOR) && scope instanceof HTMLTextAreaElement)
    scope.readOnly = true
  for (const textarea of scope.querySelectorAll<HTMLTextAreaElement>(NOTE_TEXTAREA_SELECTOR))
    textarea.readOnly = true
}

/** 在 root 下观察批注文本框，出现就设为只读（已经在的也设）；返回断开观察的函数，可以重复调用 */
export function lockNotePopups(root: Element = document.body): () => void {
  lockIn(root)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element)
          lockIn(node)
      }
    }
  })
  observer.observe(root, { childList: true, subtree: true })
  return () => observer.disconnect()
}
