// 面板的防抖（M3-P4 设计 §3.4"面板的防抖"、§7 的风险表）：批注浮层与数据验证的详情面板把改动按 SDK 的防抖写进模型（300 ms、1 秒，
// internal-api 的 PANEL_DEBOUNCES），关闭面板既不提交也不取消、没有对外的"立即提交"。退出编辑、交出要销毁编辑器，到点之前销毁就丢了；
// 按保存的捕获也会漏掉这最后一段。所以记下这些面板开着时的每一次用户输入（键入、点选、粘贴、拖放、组字结束），
// "SDK 的防抖到点"的时刻是它加上那个面板的时长；捕获之前（立即上传在按下时的准备：snapshot-capture.ts 的 settleInputs；失去编辑权的捕获）
// 等到这一刻。
// - 只在有这样的输入时等，等的是 SDK 自己的时长，从真实的最后一次输入算起——不是凭空猜一个固定的等待；
// - 在 document 上以捕获阶段监听：这里记下时刻在 SDK 的处理（React 的事件、它设计时器）之前，所以 SDK 的计时器到点早于这里算出的时刻，
//   再多等 PANEL_SETTLE_MARGIN_MS 只为让它先执行（计时器按到点的先后执行）；交互屏障挂着时（退出编辑、换编辑器）输入在窗口上就被拦下，
//   这里收不到，那时也不会有新的改动；
// - 面板是不是开着按 SDK 的 DOM 标记看，不按事件的目标：数据验证面板的下拉框挂在 body 下，范围在表格上选，目标都不在面板里；
//   面板开着时别处的输入同样算（多等至多 1 秒，宁可多等）；
// - 页面自己的界面（编辑器页的页头）里的输入不算（ignoreWithin）。
// 做不到的（盲区）：SDK 改了防抖的时长或写法（E2E 回归先失败）；不经这些 DOM 事件的改动（目前没有）

import { PANEL_DEBOUNCES } from './internal-api/index.ts'

/** 到点之后再多等的一点（毫秒）：让 SDK 的计时器先执行（见文件头），不是对 SDK 时长的估计 */
export const PANEL_SETTLE_MARGIN_MS = 20

/** 算作用户在面板里改动的事件 */
const INPUT_EVENTS = ['input', 'change', 'keydown', 'pointerup', 'click', 'paste', 'cut', 'drop', 'compositionend'] as const

export interface PanelDebounceWatch {
  /** 面板里最近的改动都已写进模型（SDK 的防抖到点）之后兑现；没有在等的时立即兑现。从不失败；销毁时立即兑现 */
  readonly settled: () => Promise<void>
  /** 还在等的那一刻（单调的时钟上，含 PANEL_SETTLE_MARGIN_MS）；没有在等的为 undefined */
  readonly pendingUntil: () => number | undefined
  readonly dispose: () => void
}

export interface PanelDebounceWatchOptions {
  /** 目标在它里面的输入不算（编辑器页的页头） */
  readonly ignoreWithin?: Node | undefined
  /** 单调的"现在"（毫秒，默认 performance.now）与计时器（默认 setTimeout）：测试换成假的 */
  readonly now?: () => number
  readonly schedule?: (callback: () => void, delayMs: number) => () => void
}

function browserSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

export function watchPanelDebounces(target: Document, options: PanelDebounceWatchOptions = {}): PanelDebounceWatch {
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? browserSchedule
  /** SDK 的防抖最晚到点的时刻（含余量）；没有在等的为 undefined */
  let due: number | undefined
  /** 在等的 settled：销毁时立即放行 */
  const waiting = new Set<() => void>()
  let disposed = false

  const onInput = (event: Event): void => {
    if (event.target instanceof Node && options.ignoreWithin?.contains(event.target) === true)
      return
    const at = now()
    for (const debounce of PANEL_DEBOUNCES) {
      if (target.querySelector(debounce.selector) !== null)
        due = Math.max(due ?? Number.NEGATIVE_INFINITY, at + debounce.delayMs + PANEL_SETTLE_MARGIN_MS)
    }
  }
  for (const type of INPUT_EVENTS)
    target.addEventListener(type, onInput, { capture: true })

  const pendingUntil = (): number | undefined => (due !== undefined && due > now() ? due : undefined)

  return {
    pendingUntil,
    settled: async () => {
      const until = pendingUntil()
      if (until === undefined || disposed)
        return
      await new Promise<void>((resolve) => {
        let cancel: () => void = () => {}
        const release = (): void => {
          cancel()
          waiting.delete(release)
          resolve()
        }
        cancel = schedule(release, until - now())
        waiting.add(release)
      })
    },
    dispose: () => {
      disposed = true
      for (const type of INPUT_EVENTS)
        target.removeEventListener(type, onInput, { capture: true })
      for (const release of [...waiting])
        release()
    },
  }
}
