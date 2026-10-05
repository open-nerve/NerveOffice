// 子进程一侧接任务（ProcessPool 的另一半，process-pool.ts）：加载好之后回 ready；每收到一个任务，交给 handle，把结果回给主进程。
// 源码运行时（单元测试、集成测试）子进程的入口由 Node 直接剥离类型执行：入口引用到的文件（这一个与入口用到的业务代码）
// 只能用"可擦除"的 TypeScript 写法——不用参数属性、枚举、命名空间、装饰器——所以它不放在 process-pool.ts 里
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

/**
 * 在子进程里接任务（由 ProcessPool 经 child_process.fork 启动、带 IPC 通道，序列化方式是 advanced）：
 * - handle 抛出时回 error，主进程那边这个任务按 crashed 失败、子进程被丢弃；结果不能序列化时同样回 error；
 * - IPC 断开（主进程退出、崩溃或被强制结束）时立即退出，不留孤儿。正在执行任务时 handle 是同步的，做完这一个才轮到它；
 *   之后回结果失败（通道已经关了）同样退出
 */
export function serveProcessTasks<Task, Result>(handle: (task: Task) => Result): void {
  if (process.send === undefined)
    throw new Error('只能在带 IPC 通道的子进程里执行（child_process.fork）')
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
