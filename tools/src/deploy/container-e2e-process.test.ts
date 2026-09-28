// 编排脚本的进程控制（Codex 评审 CX12、CX13）：信号的转发规则用假的子进程与时钟测，长命令的执行用真实的子进程测
// （各在自己的进程组里、信号发给谁、主进程退出之后等整个进程组）。
import type { TrackedChild } from './container-e2e-process.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createInterruption, ESCALATE_AFTER_MS, runCleanup, runTracked, signalGroup } from './container-e2e-process.ts'

function fakeChild(pid = 4242): TrackedChild & { signals: string[] } {
  const signals: string[] = []
  return { pid, signals, kill: (signal) => {
    signals.push(`leader ${signal}`)
    return true
  } }
}

describe('收到终止信号时转给正在运行的长命令（Codex 评审 CX12）', () => {
  function setup() {
    let clock = 0
    const groupSignals: string[] = []
    const interruption = createInterruption({
      now: () => clock,
      signalGroup: (pid, signal) => {
        groupSignals.push(`group ${pid} ${signal}`)
        return true
      },
    })
    return { interruption, groupSignals, advance: (ms: number) => {
      clock += ms
    } }
  }

  it('没有长命令在运行时只记下已中断', () => {
    const { interruption, groupSignals } = setup()
    expect(interruption.interrupted()).toBe(false)
    interruption.receive()
    expect(interruption.interrupted()).toBe(true)
    expect(groupSignals).toEqual([])
  })

  it('docker（整个进程组）：第一次发 SIGINT 给整个进程组，1 秒之内再收到的算同一次，1 秒以上再收到时 SIGKILL 整个进程组', () => {
    const { interruption, groupSignals, advance } = setup()
    const child = fakeChild()
    interruption.track(child, 'group')
    interruption.receive()
    advance(ESCALATE_AFTER_MS - 1)
    interruption.receive()
    expect(groupSignals).toEqual(['group 4242 SIGINT'])
    advance(1)
    interruption.receive()
    expect(groupSignals).toEqual(['group 4242 SIGINT', 'group 4242 SIGKILL'])
    expect(child.signals).toEqual([])
  })

  it('Playwright（只发给主进程）：第一次的 SIGINT 只发给主进程，强制结束时仍是整个进程组', () => {
    const { interruption, groupSignals, advance } = setup()
    const child = fakeChild()
    interruption.track(child, 'leader')
    interruption.receive()
    expect(child.signals).toEqual(['leader SIGINT'])
    expect(groupSignals).toEqual([])
    advance(ESCALATE_AFTER_MS)
    interruption.receive()
    expect(groupSignals).toEqual(['group 4242 SIGKILL'])
  })

  it('已经中断之后才登记的长命令立即收到 SIGINT；注销之后的信号不再转给它', () => {
    const { interruption, groupSignals } = setup()
    interruption.receive()
    const untrack = interruption.track(fakeChild(7), 'group')
    expect(groupSignals).toEqual(['group 7 SIGINT'])
    untrack()
    interruption.receive()
    expect(groupSignals).toEqual(['group 7 SIGINT'])
  })

  it('换了一个长命令：新的从第一次 SIGINT 算起', () => {
    const { interruption, groupSignals, advance } = setup()
    const untrack = interruption.track(fakeChild(1), 'group')
    interruption.receive()
    untrack()
    advance(5 * ESCALATE_AFTER_MS)
    interruption.track(fakeChild(2), 'group')
    expect(groupSignals).toEqual(['group 1 SIGINT', 'group 2 SIGINT'])
  })
})

// 起真实的子进程：CI 的机器比本机慢几倍，时限留足余量
describe('长命令异步执行、在自己的进程组里（真实的子进程）', { timeout: 30_000 }, () => {
  let directory: string | undefined
  const pids: number[] = []

  afterEach(() => {
    for (const pid of pids.splice(0)) {
      signalGroup(pid, 'SIGKILL')
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {}
    }
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })

  function marker(name: string): string {
    directory ??= mkdtempSync(join(tmpdir(), 'nerve-process-'))
    return join(directory, name)
  }

  async function waitFor(path: string): Promise<void> {
    for (let i = 0; !existsSync(path); i++) {
      if (i > 800)
        throw new Error(`等不到 ${path}`)
      await delay(25)
    }
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    }
    catch {
      return false
    }
  }

  const node = (code: string): [string, string[]] => [process.execPath, ['-e', code]]

  /**
   * 主进程起一个同组的子进程（相当于 docker 的插件、Playwright 的工作进程），子进程收到 SIGINT 时写下标记再退出；
   * 主进程收到 SIGINT 时以 exitCode 退出。子进程装好信号处理之后把自己的进程号写进 ready（这时主进程的也早已装好）
   */
  function leaderWithGrandchild(exitCode: number, ready: string, grandchildGotSigint: string): [string, string[]] {
    const grandchild = [
      `process.on('SIGINT', () => { require('node:fs').writeFileSync(${JSON.stringify(grandchildGotSigint)}, ''); process.exit(0) })`,
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid))`,
      'setInterval(() => {}, 1000)',
    ].join('\n')
    return node([
      `process.on('SIGINT', () => process.exit(${exitCode}))`,
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1000)',
    ].join('\n'))
  }

  it('返回退出码，收集输出；命令启动不了时是 1', async () => {
    const interruption = createInterruption()
    const [command, args] = node('process.stdout.write("out");process.stderr.write("err");process.exit(3)')
    expect(await runTracked(interruption, command, args, { cwd: tmpdir(), capture: true })).toEqual({ status: 3, stdout: 'out', stderr: 'err' })
    const missing = await runTracked(interruption, 'nerve-no-such-command', [], { cwd: tmpdir(), capture: true })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('ENOENT')
  })

  it('收到终止信号：SIGINT 发给整个进程组（docker 的插件进程同样收到），全部退出之后才返回', async () => {
    const ready = marker('ready')
    const grandchildGotSigint = marker('grandchild')
    const interruption = createInterruption()
    const [command, args] = leaderWithGrandchild(130, ready, grandchildGotSigint)
    const running = runTracked(interruption, command, args, { cwd: tmpdir(), capture: true, groupExitTimeoutMs: 5_000 })
    await waitFor(ready)
    const grandchild = Number(readFileSync(ready, 'utf8'))
    pids.push(grandchild)
    interruption.receive()
    const result = await running
    expect(result.status).toBe(130)
    expect(existsSync(grandchildGotSigint)).toBe(true)
    expect(alive(grandchild)).toBe(false)
  })

  it('只发给主进程（Playwright）：同组的其他进程收不到 SIGINT；主进程退出之后等进程组，到时强制结束留下的进程', async () => {
    const ready = marker('ready')
    const grandchildGotSigint = marker('grandchild')
    const interruption = createInterruption()
    const [command, args] = leaderWithGrandchild(5, ready, grandchildGotSigint)
    const running = runTracked(interruption, command, args, { cwd: tmpdir(), capture: true, signalTarget: 'leader', groupExitTimeoutMs: 300 })
    await waitFor(ready)
    const grandchild = Number(readFileSync(ready, 'utf8'))
    pids.push(grandchild)
    interruption.receive()
    expect((await running).status).toBe(5)
    expect(existsSync(grandchildGotSigint)).toBe(false)
    expect(alive(grandchild)).toBe(false)
  })

  it('不理会 SIGINT 的长命令：1 秒以上再收到信号时强制结束整个进程组', async () => {
    const ready = marker('ready')
    let clock = 0
    const interruption = createInterruption({ now: () => clock })
    const [command, args] = node(`process.on('SIGINT', () => {});require('node:fs').writeFileSync(${JSON.stringify(ready)}, '');setInterval(() => {}, 1000)`)
    const running = runTracked(interruption, command, args, { cwd: tmpdir() })
    await waitFor(ready)
    interruption.receive()
    await delay(100)
    clock += ESCALATE_AFTER_MS
    interruption.receive()
    expect((await running).status).toBe(1)
  })
})

describe('清理的每一步都执行（Codex 评审 CX13）', () => {
  it('一步抛错或没有成功，后面的步骤照样执行，结果是失败，并记下原因', () => {
    const ran: string[] = []
    const messages: string[] = []
    const ok = runCleanup([
      { label: '收集日志', run: () => {
        ran.push('logs')
        throw new Error('EEXIST: file already exists')
      } },
      { label: '删除测试环境', run: () => {
        ran.push('down')
        return false
      } },
      { label: '去掉镜像标签', run: () => {
        ran.push('image')
        return true
      } },
      { label: '删除临时目录', run: () => {
        ran.push('directory')
        return true
      } },
    ], message => messages.push(message))
    expect(ran).toEqual(['logs', 'down', 'image', 'directory'])
    expect(ok).toBe(false)
    expect(messages).toEqual(['收集日志失败：EEXIST: file already exists', '删除测试环境没有成功'])
  })

  it('全部成功时结果是成功，不记任何说明', () => {
    const messages: string[] = []
    expect(runCleanup([{ label: 'a', run: () => true }, { label: 'b', run: () => true }], message => messages.push(message))).toBe(true)
    expect(messages).toEqual([])
  })
})
