// 用构建产物启动真实的 api 进程，验证只有真实进程才有的行为：启动失败的退出码、信号处理。
// pnpm test:integration 会先构建 api。
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const API_MAIN = fileURLToPath(new URL('../../../../apps/api/dist/app/main.js', import.meta.url))

export interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export type LogEntry = Record<string, unknown>

export interface ApiProcess {
  /** 到目前为止的标准输出与标准错误 */
  output: () => string
  /** 等待一行满足条件的 JSON 日志；进程先退出或超时都会失败 */
  waitForLog: (predicate: (entry: LogEntry) => boolean, timeoutMs?: number) => Promise<LogEntry>
  kill: (signal: NodeJS.Signals) => void
  readonly exited: Promise<ProcessExit>
}

function parseLine(line: string): LogEntry | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as LogEntry : undefined
  }
  catch {
    return undefined
  }
}

function findEntry(output: string, predicate: (entry: LogEntry) => boolean): LogEntry | undefined {
  for (const line of output.split('\n')) {
    const entry = parseLine(line)
    if (entry !== undefined && predicate(entry))
      return entry
  }
  return undefined
}

/** 启动 api 进程。环境变量只有 PATH 与给定的这些，不继承测试进程的环境。 */
export function startApiProcess(env: Readonly<Record<string, string>>): ApiProcess {
  if (!existsSync(API_MAIN))
    throw new Error(`找不到 ${API_MAIN}：先构建 api（pnpm test:integration 会自动构建）`)
  const child = spawn(process.execPath, [API_MAIN], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let hasExited = false
  /** 输出有变化或进程退出时通知正在等待的调用方 */
  const listeners = new Set<() => void>()
  function notify(): void {
    for (const listener of listeners)
      listener()
  }
  function append(chunk: Buffer): void {
    output += chunk.toString('utf8')
    notify()
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => {
      hasExited = true
      resolve({ code, signal })
      notify()
    })
  })

  async function waitForLog(predicate: (entry: LogEntry) => boolean, timeoutMs = 10_000): Promise<LogEntry> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      function finish(settle: () => void): void {
        clearTimeout(timer)
        listeners.delete(check)
        settle()
      }
      function check(): void {
        const entry = findEntry(output, predicate)
        if (entry !== undefined)
          finish(() => resolve(entry))
        else if (hasExited)
          finish(() => reject(new Error(`进程已经退出，没有等到期望的日志。输出：\n${output}`)))
      }
      timer = setTimeout(() => finish(() => reject(new Error(`${timeoutMs} ms 内没有等到期望的日志。输出：\n${output}`))), timeoutMs)
      listeners.add(check)
      check()
    })
  }

  return {
    output: () => output,
    waitForLog,
    kill: signal => child.kill(signal),
    exited,
  }
}
