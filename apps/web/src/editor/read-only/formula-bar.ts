// 只读时编辑栏点不进去（M2-P3 S3 的 E2E 发现之后；P3 审查 A1 之后加了第二层）。
// 问题：工作簿不可编辑、又没有保护规则时，编辑栏的编辑器可以被聚焦，EDITOR_ACTIVATED 等上下文随之置为真，而复位它们的路径
// （单元格编辑器关闭时的 _exitInput，editing.render-controller.ts:870-874）只读时走不到：之后查找与方向键的快捷键（前提是编辑器
// 没有激活）失效，格式的快捷键转给了文字编辑器，键入的字进了编辑栏的内部文档。这是 SDK 在"工作簿不可编辑"这条路径上的缺陷，
// 聚焦的入口有两条：
// - 在编辑框上按下：sheets-ui 的 FormulaBar.tsx:252-262 置 FOCUSING_FX_BAR_EDITOR，再聚焦编辑栏的编辑器；
// - 在编辑框上松开（按下在别处，例如名称框）：sheets-formula-ui 的编辑框自己的 onMouseUp（views/formula-editor/index.tsx:535-549、
//   hooks/use-focus.ts:60）聚焦编辑器，组件的内部状态随之置为聚焦，渲染之后它的 useRefactorEffect（use-refactor-effect.ts）
//   再置一次 EDITOR_ACTIVATED。
// 两层处理：
// 1. blockFormulaBarInput：在页面上（捕获阶段）拦下落在编辑框与左边的取消、确认、插入函数按钮上的按下与点击，SDK 的处理根本
//    收不到，编辑框不会被聚焦（阻止 pointerdown、mousedown 的默认行为）。不拦松开：查找面板等拖动靠 document 上的 mouseup 结束，
//    在捕获阶段拦下会让它们收不到；
// 2. releaseFormulaBarEditor：不管从哪条路径聚焦了编辑栏的编辑器，都马上放开：订阅编辑器服务的 focus$，焦点落到编辑栏的编辑器时，
//    在当前的输入处理完之后（微任务：SDK 在聚焦之后还要把 DOM 的焦点移到编辑框、设光标，组件渲染之后再置 EDITOR_ACTIVATED，
//    这些都在同一次事件的同步部分与 React 的提交里完成，React 的提交排在这之前的微任务里）调用 blur(true)：它复位
//    EDITOR_ACTIVATED、FOCUSING_EDITOR_STANDALONE、FOCUSING_COMMENT_EDITOR，移走编辑框的 DOM 焦点，把当前文档换回聚焦之前的；
//    另把 FormulaBar 自己设的 FOCUSING_FX_BAR_EDITOR 复位（与 SDK 结束编辑时复位的是同一组上下文）。
// 编辑栏照常显示当前单元格的内容；名称框与展开的箭头不拦。
// 不用 sheets-ui 的 disableEdit：它让单元格编辑器不渲染，键盘的焦点没有着落，复制（Ctrl/Cmd+C）与方向键都失效；
// 编辑框的外层还写着 pointer-events: auto（FormulaBar.tsx:374），编辑栏照样点得进去（M2-P3 S3 修复时的实测）。
// 找元素用的是 SDK 的 DOM 标记（internal-api 的 FORMULA_BAR_INPUT_SELECTOR），编辑栏的编辑器与上下文用的是 SDK 的服务与常量，都已登记
import type { IContextService } from '../internal-api/index.ts'
import type { IEditorService } from '../internal-api/ui.ts'
import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, FOCUSING_FX_BAR_EDITOR, FORMULA_BAR_INPUT_SELECTOR } from '../internal-api/index.ts'

/** 拦下的事件：按下（SDK 的处理与编辑框的聚焦）、点击与双击（按钮） */
const BLOCKED_EVENTS = ['pointerdown', 'mousedown', 'click', 'dblclick'] as const

/**
 * 在 target（默认整页）上拦下编辑栏的输入；返回撤掉拦截的函数，可以重复调用。
 * 代价：这几个事件在捕获阶段就停下，document 以下的监听都收不到，包括 SDK"点别处就关掉浮层"的处理——
 * 只读时菜单与浮层本来关掉了大半，剩下的（批注浮层、查找面板）由 E2E 覆盖（复验 S2）
 */
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

/** 放开编辑栏要用的 SDK 服务（经 internal-api 取得） */
export interface FormulaBarServices {
  readonly editors: Pick<IEditorService, 'focus$' | 'getFocusId' | 'blur'>
  readonly context: Pick<IContextService, 'getContextValue' | 'setContextValue'>
}

/**
 * 编辑栏的编辑器一被聚焦就放开（见文件开头）；装上时已经聚焦的（M3 的原地切换）立即放开。
 * 返回撤掉的函数，可以重复调用；撤掉之后，已经排队的放开也不再执行
 */
export function releaseFormulaBarEditor({ editors, context }: FormulaBarServices): () => void {
  let active = true
  const focusedOnBar = (): boolean => editors.getFocusId() === DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY
  const release = (): void => {
    if (!active)
      return
    // 排队期间焦点已经离开编辑栏（别的路径已经放开）时不再 blur：那会把之后聚焦的编辑器一并放开
    if (focusedOnBar())
      editors.blur(true)
    // 值没变就不写：SDK 的上下文服务不去重，每次写都广播一次，订阅的界面都要重算一轮（复验 S3）
    if (context.getContextValue(FOCUSING_FX_BAR_EDITOR))
      context.setContextValue(FOCUSING_FX_BAR_EDITOR, false)
  }
  const subscription = editors.focus$.subscribe(() => {
    if (focusedOnBar())
      queueMicrotask(release)
  })
  if (focusedOnBar())
    release()
  return () => {
    active = false
    subscription.unsubscribe()
  }
}
