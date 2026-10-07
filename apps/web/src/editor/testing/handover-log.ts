// 测试构建的交接日志（M3-P5 设计 §3.13 的观察钩子）：编辑器页把交接的各步（features/sheet-editor/handover-trace.ts 的事件：发出交接请求、收到
// ack/busy/done/failed、锁空了、没有回应，开始申请与结果、进入编辑、离开编辑、锁被抢，请求编辑的发出、续期的结果、交给了本页与开始进入）报给这里，
// 按先后记下，另记报出时的墙上时间（Date.now：两个标签页的单调时钟起点不同，跨标签页比先后用它）。挂在 window 上：
// - log()：到现在的记录（拷贝），每条是事件本身（kind、at 与各自的字段）加上 wall；
// - clear()：清空；
// - subscribe(listener)：每记下一条就同步交给 listener（拷贝），返回退订的函数；listener 出错不影响记录（交给编辑器页上报）。
// 真实 Safari 的复核（§3.14）读两个标签页各自的日志：有没有回应、多久进入编辑、旧标签页什么时候得知被抢。
// 只在测试构建里：编辑器页的组装处（features/sheet-editor/start.tsx）在 import.meta.env.MODE === 'e2e' 的分支里动态引入它；生产构建里没有它
// （门禁 artifacts 按来源认出 editor/testing/，挂在 window 上的名字另由禁用关键字核对）。
// 这个文件不引用任何模块（nerve/editor-testing-shared）：E2E 与页面自检也引用它（挂在 window 上的名字、记录的写法）。

/** 日志挂在 window 上的名字：E2E 与页面自检经它读（page.evaluate） */
export const HANDOVER_LOG_GLOBAL = '__nerveHandoverLog'

/** 日志最多留这么多条（长时间开着的页面不至于一直涨） */
const LOG_LIMIT = 2000

/** 报来的事件（handover-trace.ts 的 HandoverTraceEvent 都满足它）：种类、报出的时刻（编辑模式的单调时钟）与各自的字段 */
export interface HandoverLogEvent {
  readonly kind: string
  readonly at: number
}

/** 日志里的一条：事件本身加上记下时的墙上时间（毫秒） */
export type HandoverLogEntry = HandoverLogEvent & { readonly wall: number } & Readonly<Record<string, unknown>>

/** 挂在 window 上的日志（E2E 与页面自检经 page.evaluate 调用） */
export interface HandoverLog {
  readonly log: () => HandoverLogEntry[]
  readonly clear: () => void
  readonly subscribe: (listener: (entry: HandoverLogEntry) => void) => () => void
}

/** 交给编辑器页的那一面：observe 记下一条（编辑器页的 handoverTrace） */
export interface InstalledHandoverLog {
  readonly observe: (event: HandoverLogEvent) => void
  /** 挂在 window 上的那一个（单元测试用） */
  readonly log: HandoverLog
}

/** 装上日志：挂到 window 上，交回给编辑器页的那一面。wallNow 是墙上时间（默认 Date.now；单元测试换成假的） */
export function installHandoverLog(target: Window, wallNow: () => number = () => Date.now()): InstalledHandoverLog {
  const entries: HandoverLogEntry[] = []
  const listeners = new Set<(entry: HandoverLogEntry) => void>()
  const log: HandoverLog = {
    log: () => entries.map(entry => structuredClone(entry)),
    clear: () => {
      entries.length = 0
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  ;(target as unknown as Record<string, unknown>)[HANDOVER_LOG_GLOBAL] = log
  return {
    observe: (event) => {
      const entry: HandoverLogEntry = structuredClone({ ...event, wall: wallNow() })
      entries.push(entry)
      if (entries.length > LOG_LIMIT)
        entries.splice(0, entries.length - LOG_LIMIT)
      for (const listener of [...listeners])
        listener(structuredClone(entry))
    },
    log,
  }
}
