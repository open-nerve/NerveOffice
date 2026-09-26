// 用构建产物启动真实的 api 进程，验证只有真实进程才有的行为：启动失败的退出码、信号处理、迁移与初始化管理员的命令。
// pnpm test:integration 会先构建 api。
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** 构建产物里的入口：应用、迁移命令、初始化管理员的命令。 */
const ENTRIES = {
  'main': fileURLToPath(new URL('../../../../apps/api/dist/app/main.js', import.meta.url)),
  'migrate': fileURLToPath(new URL('../../../../apps/api/dist/cli/migrate.js', import.meta.url)),
  'init-admin': fileURLToPath(new URL('../../../../apps/api/dist/cli/init-admin.js', import.meta.url)),
}

export type ApiEntry = keyof typeof ENTRIES

export interface ApiProcessOptions {
  /** 命令行参数 */
  args?: readonly string[]
  /** 写进标准输入的内容（写完即关闭）；不给时标准输入为空，也不是终端 */
  stdin?: string
}
/** 构建产物的来源：api 与 contracts 的源码（包括迁移文件）。 */
const SOURCES = ['../../../../apps/api/src', '../../../../packages/contracts/src'].map(path => fileURLToPath(new URL(path, import.meta.url)))

function newestModification(dir: string): number {
  return Math.max(0, ...readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => statSync(join(entry.parentPath, entry.name)).mtimeMs))
}

/** 构建产物必须比源码新：直接运行 vitest 时容易拿旧的产物测旧的代码（审查 B14）。 */
function assertBuildIsFresh(script: string): void {
  const hint = 'pnpm test:integration 会先构建 api；单独运行时先执行 pnpm --filter "@nerve-office/api..." run build'
  if (!existsSync(script))
    throw new Error(`找不到 ${script}：${hint}`)
  const built = statSync(script).mtimeMs
  if (SOURCES.some(dir => newestModification(dir) > built))
    throw new Error(`构建产物比源码旧：${hint}`)
}

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

/** 启动 api 的进程（默认是应用，也可以是命令）。环境变量只有 PATH 与给定的这些，不继承测试进程的环境。 */
export function startApiProcess(env: Readonly<Record<string, string>>, entry: ApiEntry = 'main', options: ApiProcessOptions = {}): ApiProcess {
  const script = ENTRIES[entry]
  assertBuildIsFresh(script)
  const child = spawn(process.execPath, [script, ...(options.args ?? [])], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end(options.stdin ?? '')
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
  // 用 close 而不是 exit：exit 时标准输出与标准错误可能还没读完，随后找日志会漏掉最后几行（审查 B14）
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('close', (code, signal) => {
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
