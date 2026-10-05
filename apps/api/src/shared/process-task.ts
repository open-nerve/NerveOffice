// 子进程一侧接任务（ProcessPool 的另一半，process-pool.ts）：加载好之后回 ready；每收到一个任务，交给 handle，把结果回给主进程。
// 源码运行时（单元测试、集成测试）子进程的入口由 Node 直接剥离类型执行：入口引用到的文件（这一个与入口用到的业务代码）
// 只能用"可擦除"的 TypeScript 写法——不用参数属性、枚举、命名空间、装饰器——所以它不放在 process-pool.ts 里
import { writeFileSync } from 'node:fs'
import process from 'node:process'

/** 主进程交给子进程的消息：一个任务 */
export interface TaskMessage<Task> {
  readonly type: 'task'
  readonly task: Task
}

/**
 * 子进程回给主进程的消息：加载好了（ready，只回一次）；任务的结果（result）；任务抛出（error，抛出的错误）。
 * 一个子进程一次只执行一个任务：主进程等到回了 result 或 error 才交下一个
 */
export type ChildMessage<Result>
  = | { readonly type: 'ready' }
    | { readonly type: 'result', readonly value: Result }
    | { readonly type: 'error', readonly error: Error }

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown))
}

/** Linux 上进程自己的 OOM 调整值（-1000–1000，越大越先被内核的 OOM killer 挑中） */
export const OOM_SCORE_ADJ_PATH = '/proc/self/oom_score_adj'

/** 子进程的 OOM 调整值：最大。内存用尽时内核先挑子进程 */
export const CHILD_OOM_SCORE_ADJ = 1000

/** 写一个文件（测试里换成假的） */
export type FileWriter = (path: string, content: string) => void

/**
 * 子进程把自己的 oom_score_adj 调到最大（Linux）：容器的 cgroup 内存用尽时，内核的 OOM killer 先结束子进程，保住主进程——
 * 子进程处理的是外来的快照，内存的峰值在它这里；结束的只是这一个检查（主进程按 crashed 处理、回 503，下一个任务起新的子进程），
 * 主进程被挑中则整个服务中断。只调高不需要特权（调低才要 CAP_SYS_RESOURCE），主进程的值不受影响（只改子进程自己）。
 * 写不了就跳过（不是 Linux、/proc 只读、被沙箱拦下）：这只是 OOM 时的偏好，不影响检查本身。返回是否调成了
 */
export function preferOomKill(platform: NodeJS.Platform = process.platform, write: FileWriter = writeFileSync): boolean {
  if (platform !== 'linux')
    return false
  try {
    write(OOM_SCORE_ADJ_PATH, String(CHILD_OOM_SCORE_ADJ))
    return true
  }
  catch {
    return false
  }
}

/**
 * 在子进程里接任务（由 ProcessPool 经 child_process.fork 启动、带 IPC 通道，序列化方式是 advanced）：
 * - 回 ready 之前先把自己的 oom_score_adj 调到最大（preferOomKill，只在 Linux 上）；
 * - handle 抛出时回 error，主进程那边这个任务按 crashed 失败、子进程被丢弃；结果不能序列化时同样回 error；
 * - IPC 断开（主进程退出、崩溃或被强制结束）时立即退出，不留孤儿。正在执行任务时 handle 是同步的，做完这一个才轮到它；
 *   之后回结果失败（通道已经关了）同样退出
 */
export function serveProcessTasks<Task, Result>(handle: (task: Task) => Result): void {
  if (process.send === undefined)
    throw new Error('只能在带 IPC 通道的子进程里执行（child_process.fork）')
  preferOomKill()
  const send = (message: ChildMessage<Result>): void => {
    process.send?.(message, undefined, undefined, (error: Error | null) => {
      if (error !== null)
        process.exit(1)
    })
  }
  process.on('disconnect', () => process.exit(0))
  process.on('message', (message: TaskMessage<Task>) => {
    let reply: ChildMessage<Result>
    try {
      reply = { type: 'result', value: handle(message.task) }
    }
    catch (error) {
      reply = { type: 'error', error: asError(error) }
    }
    try {
      send(reply)
    }
    catch (error) {
      // 结果不能序列化（DataCloneError）：回这个错误，主进程按 crashed 处理
      send({ type: 'error', error: asError(error) })
    }
  })
  send({ type: 'ready' })
}
