/** 租约、草稿恢复与宿主共用的时钟：单调的"现在"与计时器（测试换成假的） */
export interface LeaseClock {
  /** 单调的时钟（毫秒，performance.now）：只用来算相隔多久，不与服务端的时间比较，也不受改系统时间的影响 */
  readonly now: () => number
  /** delayMs 毫秒之后执行一次 callback；返回取消它的函数 */
  readonly schedule: (callback: () => void, delayMs: number) => () => void
}
