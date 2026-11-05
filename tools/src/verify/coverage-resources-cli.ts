// 完整门禁 tests 一步的入口（package.json 的 test:verify，在 run.py integration 里执行；说明见 coverage-resources.ts）
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { coverageSegments, runCoverageSegments } from './coverage-resources.ts'

const code = runCoverageSegments(coverageSegments(process.env), (segment) => {
  // 子进程与本进程同在运行器的进程组里：运行器停止本轮时整组收到信号
  const result = spawnSync(segment.command, [...segment.args], { stdio: 'inherit', env: segment.env })
  return { status: result.status, signal: result.signal, ...(result.error === undefined ? {} : { error: result.error }) }
}, message => console.log(message))
process.exit(code)
