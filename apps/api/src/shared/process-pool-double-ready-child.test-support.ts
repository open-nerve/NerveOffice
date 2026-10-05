// 测试用的子进程入口：回 ready 的同一轮里紧接着又回一条 ready（复验 C10；真实的子进程只回一次）。两条都写进 IPC 通道之后
// 在闸门目录里放 SENT_FILE（目录由测试经 --env-file 给出，见 GATE_ENV）：测试见到它之前同步地等、不让出事件循环，
// 主进程随后一次读到这两条——第二条在 #execute 接着交任务之前处理，池子已经丢弃了这个子进程
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { GATE_ENV, handleFakeTask, SENT_FILE } from './process-pool-fakes.test-support.ts'
import { serveProcessTasks } from './process-task.ts'

serveProcessTasks(handleFakeTask)
// eslint-disable-next-line node/no-process-env -- 闸门目录：测试经 --env-file 交给这个子进程
const gate = process.env[GATE_ENV]
// 回调在写完之后调用：先发的那条 ready 更早写完
process.send?.({ type: 'ready' }, undefined, undefined, () => {
  if (gate !== undefined)
    writeFileSync(join(gate, SENT_FILE), '')
})
