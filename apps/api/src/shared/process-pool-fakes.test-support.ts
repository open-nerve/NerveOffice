// 测试用的假任务（process-pool.test.ts 与 snapshot-inspector.test.ts）：原样回、挡住直到放行、忙一会儿、死循环（超时）、抛出（崩溃）、
// 退出、回不该回的消息、在 JS 里一路分配（堆超限）、以 SIGKILL 结束自己（像内核的 OOM killer 那样被外部结束）、子进程的 pid、
// 堆的实际上限、Node 选项与环境变量、自己的 oom_score_adj。
// 子进程一侧的入口是 process-pool-fake-child.test-support.ts。在子进程里由 Node 直接剥离类型执行：只用可擦除的写法
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import v8 from 'node:v8'

/** 假任务：block 的 gate 是一个目录，挡住的任务在里面放一个 started-<pid> 文件，等到出现 release 文件才回结果 */
export type FakeTask
  = | { readonly kind: 'echo', readonly value: unknown }
    | { readonly kind: 'block', readonly gate: string }
    | { readonly kind: 'busy', readonly ms: number }
    | { readonly kind: 'spin' }
    | { readonly kind: 'throw' }
    | { readonly kind: 'exit' }
    | { readonly kind: 'stray', readonly message: unknown }
    | { readonly kind: 'allocate' }
    | { readonly kind: 'sigkill' }
    | { readonly kind: 'pid' }
    | { readonly kind: 'heap-limit' }
    | { readonly kind: 'environment' }
    | { readonly kind: 'oom-score' }

/** 这个进程的 oom_score_adj（Linux 的 /proc）；读不到（不是 Linux）时为 null */
export function ownOomScoreAdjustment(): number | null {
  try {
    return Number(readFileSync('/proc/self/oom_score_adj', 'utf8').trim())
  }
  catch {
    return null
  }
}

/** 挡住的任务放在 gate 目录里的文件名的前缀（后面是 pid） */
export const STARTED_PREFIX = 'started-'
/** gate 目录里出现这个文件之后，挡住的任务都回结果 */
export const RELEASE_FILE = 'release'

/** 快照检查的任务（{ bytes, profile }）也认：bytes 是一个假任务的 JSON，SnapshotInspector 的测试用它换掉真的检查 */
function fakeOf(task: FakeTask | { readonly bytes: Uint8Array }): FakeTask {
  return 'bytes' in task ? JSON.parse(new TextDecoder().decode(task.bytes)) as FakeTask : task
}

/** 同步地等 ms 毫秒（不让出事件循环，与真的检查一样） */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function handleFakeTask(received: FakeTask | { readonly bytes: Uint8Array }): unknown {
  const task = fakeOf(received)
  switch (task.kind) {
    case 'echo':
      return task.value
    case 'block': {
      writeFileSync(join(task.gate, `${STARTED_PREFIX}${process.pid}`), '')
      while (!existsSync(join(task.gate, RELEASE_FILE)))
        pause(10)
      return 'released'
    }
    case 'busy': {
      pause(task.ms)
      return 'done'
    }
    case 'spin':
      for (;;) {
        // 不让出、不回消息：只有结束子进程才停得下来
      }
    case 'throw':
      throw new Error('假任务按要求抛出')
    case 'exit':
      return process.exit(3)
    case 'stray':
      // 绕过 serveProcessTasks 直接回一条不该回的消息，然后一直挡着（池子应当丢弃这个子进程）
      process.send?.(task.message)
      for (;;)
        pause(1_000)
    case 'allocate': {
      const kept: unknown[] = []
      for (let index = 0; ; index += 1)
        kept.push({ index, text: `item-${index}` })
    }
    case 'sigkill':
      // 不经 Node 的退出流程、不写标准错误，与内核的 OOM killer 结束它一样；信号送达之前挡着，不回结果
      process.kill(process.pid, 'SIGKILL')
      for (;;)
        pause(1_000)
    case 'pid':
      return process.pid
    case 'heap-limit':
      return v8.getHeapStatistics().heap_size_limit
    case 'environment':
      // eslint-disable-next-line node/no-process-env -- 测试核对子进程的环境变量是空的（不继承主进程的）
      return { execArgv: process.execArgv, env: Object.keys(process.env) }
    case 'oom-score':
      return ownOomScoreAdjustment()
  }
}
