// 真实浏览器的前置复核（M4-P1 S1，设计 §3.6）在页面里量主线程的办法：被占住多久（事件循环两拍之间与动画帧的最长间隔），
// 与类表格 JSON 的负载。只在页面里用（要动画帧）；与 Worker 共用的在 ./probe-bytes.ts。只在测试构建里（editor/testing/）
import { bulkSheet } from './capture-samples.ts'
import { tenth } from './probe-bytes.ts'

/** 主线程在一段时间里最长被占住多久 */
export interface MainThreadStats {
  /** 事件循环两拍（setTimeout(0) 链）之间的最长间隔：近似主线程的最长阻塞，分辨率约 4 ms（浏览器对嵌套的 setTimeout 的下限） */
  readonly lagMax: number
  /** 两个动画帧之间的最长间隔：界面最长没有刷新的时间；页面隐藏时没有动画帧（null） */
  readonly frameMax: number | null
  readonly frames: number
}

export interface MainThreadWatch {
  /** 停下并交回：先让出一次，被测的那段做完之后同一个任务里接着的代码也算进去（M0-P3 报告 §6.3 第 4 条） */
  readonly stop: () => Promise<MainThreadStats>
}

/**
 * 开始看主线程（M0 的 probeEventLoopLag 与 probeFrameGap）：停下时把"上一拍到现在""上一帧到现在"也算进去——被测的工作在一段长阻塞的末尾
 * 做完、await 之后的代码在同一个任务里停下时，下一拍还没轮到，不这样算就漏掉最后这一段
 */
export function watchMainThread(): MainThreadWatch {
  let running = true
  let lagMax = 0
  let lastTick = performance.now()
  const tick = (): void => {
    if (!running)
      return
    const now = performance.now()
    lagMax = Math.max(lagMax, now - lastTick)
    lastTick = now
    setTimeout(tick, 0)
  }
  setTimeout(tick, 0)
  let frames = 0
  let frameMax = 0
  let lastFrame = performance.now()
  const frame = (): void => {
    if (!running)
      return
    const now = performance.now()
    frameMax = Math.max(frameMax, now - lastFrame)
    lastFrame = now
    frames += 1
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  return {
    stop: async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      const now = performance.now()
      running = false
      return { lagMax: tenth(Math.max(lagMax, now - lastTick)), frameMax: frames === 0 ? null : tenth(Math.max(frameMax, now - lastFrame)), frames }
    },
  }
}

/** 类表格的 JSON（明细表的单元格，./capture-samples.ts 的 bulkSheet）编码成的 UTF-8 字节：可压缩度与快照相近，gzip 之后约四分之一 */
export function tableJsonBytes(targetBytes: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(bulkSheet(targetBytes).cellData))
}
