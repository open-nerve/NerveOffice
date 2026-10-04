// 测试用的假任务（worker-pool.test.ts 与 snapshot-inspector.test.ts）：原样回、挡住直到放行、死循环（超时）、抛出（崩溃）、退出、
// 在 JS 里一路分配（内存超限、Node 能优雅地结束线程的那一种）。工作线程一侧的入口是 worker-pool-fake-worker.test-support.ts
import process from 'node:process'
import { threadId } from 'node:worker_threads'

/** 假任务：block 的 shared 是共享内存里的两个计数（Int32Array 的 STARTED、RELEASE 两项） */
export type FakeTask
  = | { readonly kind: 'echo', readonly value: unknown }
    | { readonly kind: 'block', readonly shared: SharedArrayBuffer }
    | { readonly kind: 'spin' }
    | { readonly kind: 'throw' }
    | { readonly kind: 'exit' }
    | { readonly kind: 'allocate' }
    | { readonly kind: 'thread' }

/** 已经挡住的任务数：挡住的任务先把这一项加一 */
export const STARTED = 0
/** 放行：这一项变成非零之后，挡住的任务都回结果 */
export const RELEASE = 1

/** 快照检查的任务（{ bytes, profile }）也认：bytes 是一个假任务的 JSON，SnapshotInspector 的测试用它换掉真的检查 */
function fakeOf(task: FakeTask | { readonly bytes: Uint8Array }): FakeTask {
  return 'bytes' in task ? JSON.parse(new TextDecoder().decode(task.bytes)) as FakeTask : task
}

export function handleFakeTask(received: FakeTask | { readonly bytes: Uint8Array }): unknown {
  const task = fakeOf(received)
  switch (task.kind) {
    case 'echo':
      return task.value
    case 'block': {
      const counters = new Int32Array(task.shared)
      Atomics.add(counters, STARTED, 1)
      Atomics.wait(counters, RELEASE, 0)
      return 'released'
    }
    case 'spin':
      for (;;) {
        // 不让出、不回消息：只有结束线程才停得下来
      }
    case 'throw':
      throw new Error('假任务按要求抛出')
    case 'exit':
      return process.exit(3)
    case 'allocate': {
      const kept: unknown[] = []
      for (let index = 0; ; index += 1)
        kept.push({ index, text: `item-${index}` })
    }
    case 'thread':
      return threadId
  }
}
