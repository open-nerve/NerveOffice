// 工作线程一侧接任务（WorkerPool 的另一半，worker-pool.ts）：每收到一个任务，交给 handle，把结果回给主线程。
// 源码运行时（单元测试、集成测试）工作线程的入口由 Node 直接剥离类型执行：入口引用到的文件（这一个与入口用到的业务代码）
// 只能用"可擦除"的 TypeScript 写法——不用参数属性、枚举、命名空间、装饰器——所以它不放在 worker-pool.ts 里
import { parentPort } from 'node:worker_threads'

/**
 * handle 抛出时线程以未捕获的异常结束，主线程那边这个任务按 crashed 失败、线程被丢弃。
 * 一个线程一次只执行一个任务：主线程等到回了消息才交下一个
 */
export function serveWorkerTasks<Task, Result>(handle: (task: Task) => Result): void {
  const port = parentPort
  if (port === null)
    throw new Error('只能在工作线程里执行')
  port.on('message', (task: Task) => {
    port.postMessage(handle(task))
  })
}
