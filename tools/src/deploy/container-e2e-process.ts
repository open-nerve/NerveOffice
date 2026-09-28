// 容器 E2E 的编排脚本（container-e2e-cli.ts）里可以单独测试的进程控制（Codex 评审 CX12、CX13）：
// - 长命令（docker build、compose up、compose run、Playwright）异步执行、各在自己的进程组里：同步执行时事件循环停住，
//   收到信号也处理不了，构建结束之后照样往下起测试环境（CX12）；
// - 收到终止信号时转给正在运行的长命令：第一次发 SIGINT（docker 与 Playwright 都把它当作正常停止），
//   相隔 1 秒以上再收到信号时给它的整个进程组发 SIGKILL；1 秒之内的算同一次（关掉终端时几毫秒内会连着收到好几个信号，复验 TB1）。
//   SIGINT 发给谁：docker 发给整个进程组，与终端的 Ctrl+C 一样。docker 的命令行在输出是终端时不把信号转给插件
//   （buildx、compose，它们靠终端把信号发给整个前台进程组），只发给它自己，构建照样跑完；
//   Playwright 只发给主进程：它协调工作进程停下、写出汇总与报告（复验 SB1 验证过的做法）；
// - 清理的每一步都执行：收集日志失败不能让后面的删除测试环境、去掉镜像标签、删除临时目录被跳过（CX13）。
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

/** 再次收到信号时，相隔多久才强制结束（之内的算同一次） */
export const ESCALATE_AFTER_MS = 1_000
/** 长命令的主进程退出之后，等它的进程组全部退出的上限：之后强制结束，免得和后面的步骤或清理重叠 */
export const GROUP_EXIT_TIMEOUT_MS = 10_000

/** 给整个进程组发信号；进程组已经不在时返回 false（发 0 用来探测是否还在） */
export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal)
    return true
  }
  catch (error) {
    // 没有权限给它发信号，说明进程组还在
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 正在运行的长命令里用到的部分（启动失败时没有进程号） */
export interface TrackedChild {
  readonly pid?: number | undefined
  readonly kill: (signal: NodeJS.Signals) => boolean
}

/** 第一次的 SIGINT 发给谁：整个进程组（docker），或者只发给主进程（Playwright），见文件开头 */
export type SignalTarget = 'group' | 'leader'

export interface Interruption {
  /** 收到过终止信号：之后不再开始有副作用的步骤 */
  readonly interrupted: () => boolean
  /** 收到一个终止信号（SIGINT、SIGTERM、SIGHUP） */
  readonly receive: () => void
  /** 登记正在运行的长命令（它在自己的进程组里）；已经收到过信号时立即转给它。返回注销的函数 */
  readonly track: (child: TrackedChild, target: SignalTarget) => () => void
}

export interface InterruptionOptions {
  readonly now?: () => number
  readonly signalGroup?: (pid: number, signal: NodeJS.Signals) => boolean
}

export function createInterruption(options: InterruptionOptions = {}): Interruption {
  const now = options.now ?? Date.now
  const killGroup = options.signalGroup ?? signalGroup
  let interrupted = false
  let current: { readonly child: TrackedChild, readonly target: SignalTarget, forwardedAt: number | undefined } | undefined

  const forward = (): void => {
    const pid = current?.child.pid
    if (current === undefined || pid === undefined)
      return
    if (current.forwardedAt === undefined) {
      current.forwardedAt = now()
      if (current.target === 'group')
        killGroup(pid, 'SIGINT')
      else
        current.child.kill('SIGINT')
    }
    else if (now() - current.forwardedAt >= ESCALATE_AFTER_MS) {
      killGroup(pid, 'SIGKILL')
    }
  }

  return {
    interrupted: () => interrupted,
    receive: () => {
      interrupted = true
      forward()
    },
    track: (child, target) => {
      const entry = { child, target, forwardedAt: undefined }
      current = entry
      // 检查与启动之间来的信号（按理不会：两者在同一段同步代码里），同样不能让它无人看管地跑下去
      if (interrupted)
        forward()
      return () => {
        if (current === entry)
          current = undefined
      }
    },
  }
}

export interface RunResult {
  /** 退出码；被信号结束时是 1 */
  readonly status: number
  /** capture 为真时收集的输出 */
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  /** 收集输出；否则输出直接显示在终端上 */
  readonly capture?: boolean
  /** 第一次的 SIGINT 发给谁，默认整个进程组 */
  readonly signalTarget?: SignalTarget
  readonly groupExitTimeoutMs?: number
}

/** 强制结束进程组之后，再等它真的退出（被回收）的上限 */
const KILLED_GROUP_EXIT_TIMEOUT_MS = 2_000

/** 主进程退出之后等整个进程组退出：最多 timeoutMs，之后强制结束，再等它退出 */
export async function waitForProcessGroup(pid: number, timeoutMs = GROUP_EXIT_TIMEOUT_MS): Promise<void> {
  let deadline = Date.now() + timeoutMs
  let killed = false
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline) {
      if (killed)
        return
      signalGroup(pid, 'SIGKILL')
      killed = true
      deadline = Date.now() + KILLED_GROUP_EXIT_TIMEOUT_MS
    }
    await delay(50)
  }
}

/**
 * 异步执行长命令，放在它自己的进程组里、登记给 interruption：终端的 Ctrl+C、关掉终端的 SIGHUP 只到编排脚本，
 * 由它按上面的规则转给这个命令。主进程退出之后等它的整个进程组退出（Playwright 的工作进程与浏览器、docker 的插件进程），
 * 再返回，免得和后面的步骤或清理重叠。
 */
export async function runTracked(interruption: Interruption, command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  let stdout = ''
  let stderr = ''
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', options.capture === true ? 'pipe' : 'inherit', options.capture === true ? 'pipe' : 'inherit'],
    detached: true,
  })
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const untrack = interruption.track(child, options.signalTarget ?? 'group')
  try {
    const status = await new Promise<number>((resolve) => {
      child.once('error', (error) => {
        stderr += String(error)
        resolve(1)
      })
      child.once('close', code => resolve(code ?? 1))
    })
    if (child.pid !== undefined)
      await waitForProcessGroup(child.pid, options.groupExitTimeoutMs)
    return { status, stdout, stderr }
  }
  finally {
    untrack()
  }
}

/** 清理的一步：返回是否成功；抛出的错误同样算失败 */
export interface CleanupStep {
  readonly label: string
  readonly run: () => boolean
}

/**
 * 清理的每一步都执行（Codex 评审 CX13）：一步失败（抛错或返回 false）只记下来，不跳过后面的步骤。
 * 返回是否全部成功：有一步失败，编排脚本就以非零退出，免得留下的容器、数据卷、镜像或带密码的临时目录没人发现
 */
export function runCleanup(steps: readonly CleanupStep[], log: (message: string) => void): boolean {
  let succeeded = true
  for (const step of steps) {
    try {
      if (!step.run()) {
        succeeded = false
        log(`${step.label}没有成功`)
      }
    }
    catch (error) {
      succeeded = false
      log(`${step.label}失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return succeeded
}
