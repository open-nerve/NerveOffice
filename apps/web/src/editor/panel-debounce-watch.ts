// 面板的防抖（M3-P4 设计 §3.4"面板的防抖"、§7 的风险表；Codex 评审 CX4，M3-P6 设计 §3.13）：批注浮层与数据验证的详情面板把改动按
// SDK 的防抖写进模型（300 ms、1 秒，internal-api 的 PANEL_DEBOUNCES），关闭面板既不提交也不取消、没有对外的"立即提交"。到点之前用户的
// 这段输入还没写进模型：
// - 它是"还没写进模型的输入"的一部分（uncommitted-input.ts 与单元格编辑器里的合成一个状态）：保存的状态机据此算未保存，页头不说
//   "已保存到云端"、离开提示拦下（CX4：原来这段时间离开就丢）；
// - 退出编辑、交出要销毁编辑器，到点之前销毁就丢了；按保存的捕获也会漏掉这最后一段：捕获之前（立即上传在按下时的准备：snapshot-capture.ts
//   的 settleInputs；失去编辑权的捕获）等到点（settled）。
// 所以记下这些面板开着时的每一次用户输入（键入、点选、粘贴、拖放、组字结束），"SDK 的防抖到点"的时刻是它加上那个面板的时长：
// - 只在有这样的输入时算，用的是 SDK 自己的时长，从真实的最后一次输入算起——不是凭空猜一个固定的等待；
// - 在 document 上以捕获阶段监听：这里记下时刻在 SDK 的处理（React 的事件、它设计时器）之前，所以 SDK 的计时器到点早于这里算出的时刻，
//   再多等 PANEL_SETTLE_MARGIN_MS 只为让它先执行（计时器按到点的先后执行）；交互屏障挂着时（退出编辑、换编辑器）输入在窗口上就被拦下，
//   这里收不到，那时也不会有新的改动；
// - 面板是不是开着按 SDK 的 DOM 标记看，不按事件的目标：数据验证面板的下拉框挂在 body 下，范围在表格上选，目标都不在面板里；
//   面板开着时别处的输入同样算（宁可多等至多 1 秒：这期间页头说有未保存的修改，到点没有改动就回到已保存）；
// - 页面自己的界面（编辑器页的页头）里的输入不算（ignoreWithin）。
// 状态：从第一次输入到到点是"防抖中"（pending），开始与到点各通知一次，期间再输入只把到点往后推、不通知。计时器只有一个，排在到点与
// 在等的 settled 中最早的那一刻：早到了（时钟与计时器有出入）或者到点被推后了，就接着等剩下的——不提前说"写进了模型"。
// 做不到的（盲区）：SDK 改了防抖的时长或写法（E2E 回归先失败）；不经这些 DOM 事件的改动（目前没有）

import { PANEL_DEBOUNCES } from './internal-api/index.ts'

/** 到点之后再多等的一点（毫秒）：让 SDK 的计时器先执行（见文件头），不是对 SDK 时长的估计 */
export const PANEL_SETTLE_MARGIN_MS = 20

/** 算作用户在面板里改动的事件 */
const INPUT_EVENTS = ['input', 'change', 'keydown', 'pointerup', 'click', 'paste', 'cut', 'drop', 'compositionend'] as const

export interface PanelDebounceWatch {
  /** 面板里有按 SDK 的防抖还没写进模型的输入（最后一次输入加上那个面板的时长、含余量，还没到点）；销毁之后为假 */
  readonly pending: () => boolean
  /** pending 变了：开始（第一次输入）与到点各通知一次，期间再输入不通知；销毁不通知。在计时器与 DOM 事件里同步调用 */
  readonly onChange: (listener: () => void) => () => void
  /**
   * 调用这一刻面板里的输入都已写进模型（SDK 的防抖到点）之后兑现：等的是调用时的到点，之后的输入把到点往后推也不跟着等——要存哪些在
   * 调用（按下）的这一刻定（M3-P4 审查 A1 的同一个原则），一直有人在面板里键入也不会让保存一直等下去。不在防抖中时立即兑现；
   * 从不失败；销毁时立即兑现
   */
  readonly settled: () => Promise<void>
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

/** 一个在等的 settled：等到 until（调用时的到点） */
interface Waiter {
  readonly until: number
  readonly release: () => void
}

export function watchPanelDebounces(target: Document, options: PanelDebounceWatchOptions = {}): PanelDebounceWatch {
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? browserSchedule
  const listeners = new Set<() => void>()
  /** SDK 的防抖最晚到点的时刻（含余量）；不在防抖中时为 undefined */
  let due: number | undefined
  let waiters: Waiter[] = []
  /** 唯一的计时器：at 是它排定的时刻 */
  let timer: { readonly at: number, readonly cancel: () => void } | undefined
  let disposed = false

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      }
      catch (error) {
        reportError(error)
      }
    }
  }

  /** 排上计时器：到点与在等的 settled 中最早的那一刻。已经排了不晚于它的就不动——到时候再看，没到的接着排 */
  const arm = (): void => {
    const at = Math.min(due ?? Number.POSITIVE_INFINITY, ...waiters.map(waiter => waiter.until))
    if (!Number.isFinite(at) || (timer !== undefined && timer.at <= at))
      return
    timer?.cancel()
    timer = { at, cancel: schedule(onTimer, Math.max(0, at - now())) }
  }

  function onTimer(): void {
    timer = undefined
    const at = now()
    const ended = due !== undefined && due <= at
    if (ended)
      due = undefined
    const released = waiters.filter(waiter => waiter.until <= at)
    waiters = waiters.filter(waiter => waiter.until > at)
    arm()
    // 先清掉、通知（保存的状态机随之更新），再放行在等的：它们的后续（捕获、判断有没有没存的）看到的是到点之后的状态
    if (ended)
      notify()
    for (const waiter of released)
      waiter.release()
  }

  const onInput = (event: Event): void => {
    if (event.target instanceof Node && options.ignoreWithin?.contains(event.target) === true)
      return
    const at = now()
    let next = due
    for (const debounce of PANEL_DEBOUNCES) {
      if (target.querySelector(debounce.selector) !== null)
        next = Math.max(next ?? Number.NEGATIVE_INFINITY, at + debounce.delayMs + PANEL_SETTLE_MARGIN_MS)
    }
    // 没有面板开着，或者之前的输入定下的到点更晚
    if (next === due)
      return
    const started = due === undefined
    due = next
    arm()
    if (started)
      notify()
  }
  for (const type of INPUT_EVENTS)
    target.addEventListener(type, onInput, { capture: true })

  return {
    pending: () => due !== undefined,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    settled: async () => {
      if (disposed || due === undefined)
        return
      const until = due
      await new Promise<void>((resolve) => {
        waiters.push({ until, release: resolve })
        arm()
      })
    },
    dispose: () => {
      disposed = true
      for (const type of INPUT_EVENTS)
        target.removeEventListener(type, onInput, { capture: true })
      timer?.cancel()
      timer = undefined
      due = undefined
      listeners.clear()
      const released = waiters
      waiters = []
      for (const waiter of released)
        waiter.release()
    },
  }
}
