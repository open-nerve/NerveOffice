/** 开关与两轮之间的间隔（各个任务自己的配置） */
export interface JobSchedule {
  /** 关掉之后不起定时器 */
  readonly enabled: boolean
  /** 两轮之间的间隔；实际的等待带 ±10% 的抖动 */
  readonly intervalMs: number
}

/**
 * 一个应用内的定时任务（ADR-016 第 3 条）：一轮做什么在任务自己（回收站的清理、修订记录与回执的保留期清理）；什么时候跑由 JobScheduler
 * 统一决定——第一轮的时机、抖动、一轮结束才排下一轮、失败只记日志、退出时收尾，几个任务完全相同，只写一份。
 * 防重复执行（advisory lock）与分批各任务自己做：锁的粒度跟着"一轮"的形状走（见 database 模块的 ExclusiveRunner）
 */
export interface ScheduledJob {
  /** 日志里的 job 字段，例如 trash-purge */
  readonly name: string
  /** 日志里的叫法，例如"回收站的自动清理"：已启动、已关闭、这一轮没有跑完 */
  readonly title: string
  readonly schedule: JobSchedule
  /** 关掉时日志里的说明：是哪个变量关掉的、关掉期间会怎样 */
  readonly disabled: { readonly variable: string, readonly consequence: string }
  /** 启动时日志里另带的设置（例如一批的数量），间隔与第一轮的等待由调度器写 */
  readonly settings: Readonly<Record<string, unknown>>
  /**
   * 跑一轮。now 是这一轮的"现在"（调度器在这一轮开头从时钟取一次，生产里是数据库的时间）；signal 在应用退出时中止——
   * 一轮里分几批的任务在批与批之间看它，做完手上这一批就停，退出不必等完一整轮。抛出时调度器记日志、照常排下一轮
   */
  readonly runOnce: (now: Date, signal: AbortSignal) => Promise<unknown>
}

/** 注入标记：jobs 模块里全部的定时任务（jobs.module.ts 列出），JobScheduler 逐个排程 */
export const SCHEDULED_JOBS = Symbol('nerve-office:scheduled-jobs')
