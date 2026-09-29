// 只读时编辑栏点不进去（M2-P3 S3 的 E2E 发现之后）。
// 问题：工作簿不可编辑、又没有保护规则时，点编辑栏的编辑框，sheets-ui 的 FormulaBar.tsx:252-262 只聚焦编辑栏的内部编辑器，
// 把 FOCUSING_FX_BAR_EDITOR 与（经 docs-ui 的 editor-manager.service.ts:197-225）EDITOR_ACTIVATED 设为真；单元格编辑器在只读时
// 打不开，复位这两个上下文的路径（editing.render-controller.ts:870-874）也就走不到，之后查找的快捷键（前提是编辑器没有激活）失效，
// 格式的快捷键转给了文字编辑器。这是 SDK 在"工作簿不可编辑"这条路径上的缺陷。
// 做法：只读时在页面上（捕获阶段）拦下落在编辑框与左边的取消、确认、插入函数按钮上的指针事件，SDK 的处理根本收不到，
// 编辑框不会被聚焦（阻止 pointerdown、mousedown 的默认行为）。编辑栏照常显示当前单元格的内容；名称框与展开的箭头不拦。
// 不用 sheets-ui 的 disableEdit：它让单元格编辑器不渲染，键盘的焦点没有着落，复制（Ctrl/Cmd+C）与方向键都失效；
// 编辑框的外层还写着 pointer-events: auto（FormulaBar.tsx:374），编辑栏照样点得进去（M2-P3 S3 修复时的实测）。
// 找元素用的是 SDK 的 DOM 标记（internal-api 的 FORMULA_BAR_INPUT_SELECTOR，已登记）
import { FORMULA_BAR_INPUT_SELECTOR } from '../internal-api/index.ts'

/** 拦下的事件：按下（SDK 的处理与编辑框的聚焦）、点击与双击（按钮） */
const BLOCKED_EVENTS = ['pointerdown', 'mousedown', 'click', 'dblclick'] as const

/** 在 target（默认整页）上拦下编辑栏的输入；返回撤掉拦截的函数，可以重复调用 */
export function blockFormulaBarInput(target: Document = document): () => void {
  const block = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest(FORMULA_BAR_INPUT_SELECTOR) !== null) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  for (const type of BLOCKED_EVENTS)
    target.addEventListener(type, block, { capture: true })
  return () => {
    for (const type of BLOCKED_EVENTS)
      target.removeEventListener(type, block, { capture: true })
  }
}
