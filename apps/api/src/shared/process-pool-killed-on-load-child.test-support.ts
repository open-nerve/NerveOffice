// 测试用的子进程入口：加载时（回 ready 之前）以 SIGKILL 结束自己——与加载时被外部结束（例如内核的 OOM killer）一样，不写标准错误
import process from 'node:process'

process.kill(process.pid, 'SIGKILL')
// 信号送达之前挡着，不回 ready
for (;;)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
