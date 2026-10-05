// 测试用的主进程（process-pool.test.ts 单独起一个 Node 进程执行它）：在一个真的、可以被强制结束的主进程里用池子，
// 核对子进程不留孤儿、空闲时不留住主进程。参数：
// - natural：一个子进程，先取它的 pid（打印），再交一个忙 300 毫秒的任务（打印结果），之后什么也不做、不关闭池子——
//   有任务时池子要留住主进程（否则结果打印不出来），空闲时不留（主进程自己退出，子进程随 IPC 断开退出）；
// - close：一个子进程，取它的 pid（打印），再关闭池子、打印 closed——关闭要留住主进程直到子进程退出（否则 closed 打印不出来）；
// - orphan <gate>：两个子进程，一个执行完任务后空闲（打印它的 pid），一个挡在 gate 上；之后主进程一直活着，等测试强制结束它。
// 由测试用 node --experimental-transform-types 执行（池子引用的 semaphore.ts 有参数属性）
import type { FakeTask } from './process-pool-fakes.test-support.ts'
import process from 'node:process'
import { ProcessPool } from './process-pool.ts'

const [mode, gate] = process.argv.slice(2)

function write(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

const pool = new ProcessPool<FakeTask, unknown>({
  script: new URL('./process-pool-fake-child.test-support.ts', import.meta.url),
  execArgv: [],
  processes: mode === 'orphan' ? 2 : 1,
  queue: {},
  taskTimeoutMs: 30_000,
  heapMb: 128,
  idleTimeoutMs: 600_000,
})

async function main(): Promise<void> {
  if (mode === 'natural') {
    write({ pid: await pool.run({ kind: 'pid' }) })
    write({ result: await pool.run({ kind: 'busy', ms: 300 }) })
  }
  else if (mode === 'close') {
    write({ pid: await pool.run({ kind: 'pid' }) })
    await pool.close()
    write({ closed: pool.liveProcesses === 0 })
  }
  else if (mode === 'orphan' && gate !== undefined) {
    const idle = pool.run({ kind: 'pid' })
    const blocked = pool.run({ kind: 'block', gate })
    write({ pid: await idle })
    void blocked.catch(() => undefined)
    setInterval(() => {}, 60_000)
  }
  else {
    throw new Error(`不认识的参数：${process.argv.slice(2).join(' ')}`)
  }
}

// 不用顶层的 await：池子没留住主进程时 main 还没完、进程就退出了，打印不出结果（测试据此判断）
main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
