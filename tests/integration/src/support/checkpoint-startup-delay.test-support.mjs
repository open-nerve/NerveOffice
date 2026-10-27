// 只由 checkpoint 进程回归用例通过显式 NODE_OPTIONS 加载；不修改真实 CLI 或全局环境。
// 延迟用于构造旧 1 秒启动前置失败，不能用来推断历史 CI 当时的启动耗时。
import process from 'node:process'

process.stderr.write(`${JSON.stringify({ event: 'checkpoint-test-startup-delay', phase: 'entered' })}\n`)
// 同步、有限且不忙等；preload 返回之前真实入口不能开始，不能用游离的 async 函数替代。
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
process.stderr.write(`${JSON.stringify({ event: 'checkpoint-test-startup-delay', phase: 'released' })}\n`)
