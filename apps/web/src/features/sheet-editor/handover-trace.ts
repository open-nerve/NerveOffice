// 交接的观察钩子（M3-P5 设计 §3.13）：页面不记诊断日志（没有 logger，生产代码不用 console），真实 Safari 的复核（§3.14）却要知道交接的各步
// 发生在什么时候——有没有回应、多久进入编辑、锁什么时候被抢、请求方的续期得到了什么。编辑模式（edit-mode.ts）、同一个浏览器的交接
// （self-takeover.ts）与请求编辑（edit-request.ts）在这些地方各报一条；谁来记由组装处决定：测试构建（MODE === 'e2e'）给出
// editor/testing/handover-log.ts 的记录器（挂在 window 上，页面自检与 E2E 读它），生产构建不给（undefined），各处什么也不记。
// 观察者出错不影响交接：编辑模式接住、交给 reportError（另外两处经编辑模式拿到的是接住了错误的那一个）。这里只有事件的类型。
// at 是报出的时刻（编辑模式的单调时钟，performance.now；页面上的 setTimeout 与 Playwright 的时钟都按它）；记录器另记墙上时间，跨标签页比先后用

/** 进入编辑的申请是哪一个用户的操作发起的（续上不经这里） */
export type AcquireTrigger = 'open' | 'enter' | 'take-over' | 'force' | 'granted'

export type HandoverTraceEvent
  /** 申请编辑权（用户发起的，含"在此编辑""强制接管"、请求被批准之后的自动进入）：接管方式（没有为 null） */
  = | { readonly kind: 'acquire', readonly at: number, readonly trigger: AcquireTrigger, readonly takeover: 'self' | 'force' | null }
  /** 申请的结果：取得了（带没带异常中断的提醒）、被占用、失败（错误码；网络等没有错误码时为 null） */
    | { readonly kind: 'acquire-result', readonly at: number, readonly result: 'acquired' | 'held' | 'failed', readonly interruption: boolean, readonly code: string | null }
  /** 进入了编辑（可编辑的编辑器接上了） */
    | { readonly kind: 'entered', readonly at: number }
  /** 开始离开编辑（原因）；离开的结果：回到阅读、留在编辑 */
    | { readonly kind: 'leave', readonly at: number, readonly cause: string }
    | { readonly kind: 'left', readonly at: number, readonly cause: string, readonly outcome: 'reading' | 'stayed' }
  /** 本机锁被本浏览器的另一个标签页抢走（随即向服务端核对这一代：lock-verdict） */
    | { readonly kind: 'lock-stolen', readonly at: number }
  /**
   * 本机锁的争用由服务端裁决（M3-P6 设计 §3.13，local-lock.ts）：拿锁时被本浏览器的别的标签页占着（claim）、锁被抢之后（stolen）核对这一代的结果——
   * current 是当前的（抢、拿回来），ended 已经不是当前的（不抢；被抢的转为失去编辑权），unknown 核对不了（不抢；被抢的等之后的心跳）
   */
    | { readonly kind: 'lock-verdict', readonly at: number, readonly when: 'claim' | 'stolen', readonly verdict: 'current' | 'ended' | 'unknown' }
  /**
   * 页面关闭（pagehide）时怎样处理这一代（M3-P4 设计 §3.4、M3-P5 设计 §3.7 的 R1、7a759da）：kept 是保存在途（busy）或者结果未知（unknown）、
   * 不释放、记下记号；handed-over 是有请求在等、用交出代替释放；released 是释放；idle 是不在编辑（没有这一代）。busy、unknown 是那一刻保存的
   * 状态机的样子——真实 Safari 的复核据此说清刷新时走的是哪一支（WebKit 在导航一开始就取消在途的请求，到这里已经是结果未知）
   */
    | { readonly kind: 'page-hide', readonly at: number, readonly action: 'kept' | 'handed-over' | 'released' | 'idle', readonly busy: boolean, readonly unknown: boolean }
  /** "在此编辑"开始（anyway：那边没能交出之后的"仍在此编辑"）；锁在不在本浏览器里 */
    | { readonly kind: 'takeover-start', readonly at: number, readonly anyway: boolean }
    | { readonly kind: 'takeover-locate', readonly at: number, readonly here: boolean }
  /** 请求方：发出交接请求；收到回应（ack、busy、done、failed）；锁空了（那边做完了的信号）；到了时限没有回应、没做完 */
    | { readonly kind: 'handover-request', readonly at: number, readonly requestId: string }
    | { readonly kind: 'handover-reply', readonly at: number, readonly requestId: string, readonly reply: 'ack' | 'busy' | 'done' | 'failed', readonly detail: string | null }
    | { readonly kind: 'handover-lock-free', readonly at: number }
    | { readonly kind: 'handover-silent', readonly at: number }
  /** 正在编辑的标签页：收到交接请求、怎样回应的（ack、busy；不理会的不报）；离开结束时告诉了它什么（done、failed） */
    | { readonly kind: 'handover-answer', readonly at: number, readonly requestId: string, readonly answer: 'ack' | 'busy', readonly state: string }
    | { readonly kind: 'handover-finish', readonly at: number, readonly requestId: string, readonly outcome: 'done' | 'failed', readonly reason: string | null }
  /** 请求编辑：发出、续期的结果（结果的 kind；失败时 error 与错误码）；编辑权交给了本页（页面在后台时等回到前台）与开始进入 */
    | { readonly kind: 'request-sent', readonly at: number, readonly outcome: string }
    | { readonly kind: 'request-renewed', readonly at: number, readonly outcome: string }
    | { readonly kind: 'request-granted', readonly at: number, readonly visible: boolean }
    | { readonly kind: 'request-enter', readonly at: number }

/** 观察者：每发生一步调用一次（同步，不改任何状态） */
export type HandoverTrace = (event: HandoverTraceEvent) => void
