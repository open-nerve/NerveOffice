// 主线程公式模式下销毁编辑器之前，停下正在算的一轮（M3-P4 设计 §3.14，S1 真实 Safari 复核的 F2）。
// 主线程模式（M4 的退路，M3 里只有测试构建在用）下 engine-formula 在主线程上算：每执行 intervalCount 个公式让出一次主线程，
// 停止标记只在让出点检查；Univer 实例销毁时运行时把停止标记复位（FormulaRuntimeService.dispose 调 reset）。所以在计算中销毁时，
// 这一轮不会停下：旧的循环在让出点之后接着跑，函数表已经清空，剩下的公式解析成只会得出 #NAME? 的语法树，写进 engine-formula 模块级的
// 语法树缓存（同一页里所有实例共用，键里有 unitId，重建之后不变），之后新建的编辑器算到这些格时命中它们——公式结果错了，还会被保存。
// 做法：销毁之前，有一轮在算就执行停止的 mutation（FORMULA_PROTOCOL.stopMutationId，与 SDK 的触发服务停下一轮同一个写法），
// 等这一轮结束的通知（停止或完成，FORMULA_PROTOCOL.completedStates），再销毁。代价至多一个让出间隔（20 个公式）。
// 有时限（远长于一个让出间隔）：SDK 改了停止的做法、通知不来时不一直挂着，到了时限交回 timeout，由调用方照样销毁并报告。
// Worker 模式不需要：缓存在 Worker 里，随它一起终止（sheet-editor.ts 只在主线程模式下交出这一轮）。
// 这里不依赖 Univer：一轮在不在算、进度的信号与怎样停，由调用方给出（变更检测的跟踪器与 Facade），单元测试用假的
import { deferred } from './async-tools.ts'

/**
 * 等这一轮结束至多这么久。正常是一个让出间隔（主线程模式 20 个公式，S1 实测几十到两百多毫秒）；依赖的生成在第一个让出点之前、
 * 中途不让出，大表上可能要几秒，也算在内。到了时限仍在算，说明 SDK 的约定变了：调用方照样销毁并报告页面错误（之后的公式结果
 * 可能不对），所以宁可长一些
 */
export const ROUND_STOP_TIMEOUT_MS = 30_000

/** 一轮公式计算：在不在算、进度的信号、怎样请求停下 */
export interface FormulaRound {
  /** 有一轮正在算：开始了、还没有收到它结束的通知 */
  readonly running: () => boolean
  /** 公式的进度变了（在 SDK 执行命令的过程中同步调用）；返回退订的函数 */
  readonly onProgress: (listener: () => void) => () => void
  /** 请求停下正在算的这一轮（执行停止的 mutation）：引擎在下一个让出点停下，之后发出结束的通知 */
  readonly stop: () => void
}

/** 停下的结果：本来就没有在算（idle）、这一轮结束了（ended）、到了时限还没结束（timeout） */
export type RoundStop = 'idle' | 'ended' | 'timeout'

/**
 * 有一轮在算就请求停下，等它结束（收到结束的通知），至多 timeoutMs。没有在算时立即交回 idle、什么也不做。
 * 先订阅、再请求停下：结束的通知本来是之后的命令（引擎在下一个让出点停下），万一在停下的这一步里就到来也接得住。
 * stop 抛出时照样抛出（退订与计时器都已清掉）
 */
export async function stopRunningRound(round: FormulaRound, timeoutMs: number = ROUND_STOP_TIMEOUT_MS): Promise<RoundStop> {
  if (!round.running())
    return 'idle'
  const outcome = deferred<RoundStop>()
  const unsubscribe = round.onProgress(() => {
    if (!round.running())
      outcome.resolve('ended')
  })
  const timer = setTimeout(() => outcome.resolve('timeout'), timeoutMs)
  try {
    round.stop()
    return await outcome.promise
  }
  finally {
    clearTimeout(timer)
    unsubscribe()
  }
}
