import type { FakeTask } from './process-pool-fakes.test-support.ts'
import type { ProcessPoolOptions } from './process-pool.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASE_FILE, STARTED_PREFIX } from './process-pool-fakes.test-support.ts'
import { ChildProcessExitError, ProcessPool, ProcessPoolError } from './process-pool.ts'

const SCRIPT = new URL('./process-pool-fake-child.test-support.ts', import.meta.url)
const BROKEN_SCRIPT = new URL('./process-pool-broken-child.test-support.ts', import.meta.url)
const PARENT_SCRIPT = fileURLToPath(new URL('./process-pool-parent.test-support.ts', import.meta.url))
const MIB = 1024 * 1024
/** 用例起真的子进程（与真的主进程）：慢机器上（CI 比本机慢几倍）加载与退出都要更久，留足余量 */
const SPAWNING = { timeout: 30_000 }

const pools: ProcessPool<FakeTask, unknown>[] = []
const gates: string[] = []

function pool(options: Partial<ProcessPoolOptions> = {}): ProcessPool<FakeTask, unknown> {
  const created = new ProcessPool<FakeTask, unknown>({
    script: SCRIPT,
    execArgv: [],
    processes: 2,
    queue: {},
    taskTimeoutMs: 10_000,
    heapMb: 128,
    idleTimeoutMs: 600_000,
    ...options,
  })
  pools.push(created)
  return created
}

afterEach(async () => {
  for (const directory of gates)
    writeFileSync(join(directory, RELEASE_FILE), '')
  await Promise.all(pools.splice(0).map(async created => created.close()))
  for (const directory of gates.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

/** 跨进程的闸门：挡住的任务在目录里放 started-<pid>，出现 release 文件之后放行 */
function gate(): { readonly directory: string, readonly started: () => number[], readonly release: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'process-pool-gate-'))
  gates.push(directory)
  return {
    directory,
    started: () => readdirSync(directory).filter(name => name.startsWith(STARTED_PREFIX)).map(name => Number(name.slice(STARTED_PREFIX.length))),
    release: () => writeFileSync(join(directory, RELEASE_FILE), ''),
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error('等不到条件成立')
    await sleep(10)
  }
}

/** 进程还在运行：已经退出、还没被回收的（Linux 上 /proc 里的状态是 Z）不算 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.charAt(stat.lastIndexOf(')') + 2) !== 'Z'
  }
  catch {
    return true
  }
}

async function failure(promise: Promise<unknown>): Promise<ProcessPoolError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  if (!(error instanceof ProcessPoolError))
    throw new Error(`期望 ProcessPoolError，得到 ${String(error)}`)
  return error
}

function exitOf(error: ProcessPoolError): ChildProcessExitError {
  if (!(error.cause instanceof ChildProcessExitError))
    throw new Error(`期望 cause 是 ChildProcessExitError，得到 ${String(error.cause)}`)
  return error.cause
}

describe('ProcessPool', SPAWNING, () => {
  it('交给子进程执行、拿回它的结果（Buffer 与 Uint8Array 原样往返）；子进程按需创建、留着复用', async () => {
    const children = pool()
    expect(children.liveProcesses).toBe(0)
    const value = { a: [1, 'x'], buffer: Buffer.from('正文'), bytes: new Uint8Array([1, 2, 3]) }
    const echoed = await children.run({ kind: 'echo', value }) as typeof value
    expect(echoed).toEqual(value)
    expect(Buffer.isBuffer(echoed.buffer)).toBe(true)
    expect(echoed.bytes).toBeInstanceOf(Uint8Array)
    expect(children.liveProcesses).toBe(1)
    const first = await children.run({ kind: 'pid' })
    expect(first).not.toBe(process.pid)
    expect(await children.run({ kind: 'pid' })).toBe(first)
    expect(children.liveProcesses).toBe(1)
  })

  it('同时执行的任务不超过子进程数，超出的排队', async () => {
    const children = pool({ processes: 2 })
    const blocking = gate()
    const tasks = Array.from({ length: 4 }, async () => children.run({ kind: 'block', gate: blocking.directory }))
    await until(() => blocking.started().length === 2)
    await sleep(200)
    expect(blocking.started()).toHaveLength(2)
    expect(children.liveProcesses).toBe(2)
    blocking.release()
    expect(await Promise.all(tasks)).toEqual(['released', 'released', 'released', 'released'])
    expect(children.liveProcesses).toBe(2)
  })

  it('排队满了：再来的立即失败（queue-full），没有执行', async () => {
    const children = pool({ processes: 1, queue: { maxWaiting: 1 } })
    const blocking = gate()
    const running = children.run({ kind: 'block', gate: blocking.directory })
    await until(() => blocking.started().length === 1)
    const queued = children.run({ kind: 'echo', value: 'queued' })
    expect((await failure(children.run({ kind: 'echo', value: 'rejected' }))).reason).toBe('queue-full')
    blocking.release()
    expect(await running).toBe('released')
    expect(await queued).toBe('queued')
  })

  it('排队等待超时：失败（wait-timeout）并离开队列', async () => {
    const children = pool({ processes: 1, queue: { maxWaitMs: 50 } })
    const blocking = gate()
    const running = children.run({ kind: 'block', gate: blocking.directory })
    await until(() => blocking.started().length === 1)
    expect((await failure(children.run({ kind: 'echo', value: 'late' }))).reason).toBe('wait-timeout')
    blocking.release()
    expect(await running).toBe('released')
    expect(await children.run({ kind: 'echo', value: 'next' })).toBe('next')
  })

  it('超过时限：结束那个子进程（timeout），下一个任务用新的子进程；时限从交给加载好的子进程算起', async () => {
    // 加载另有同样的时限：留足慢机器上加载的余量
    const children = pool({ processes: 1, taskTimeoutMs: 2_000 })
    const before = await children.run({ kind: 'pid' }) as number
    const started = performance.now()
    expect((await failure(children.run({ kind: 'spin' }))).reason).toBe('timeout')
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_950)
    expect(children.liveProcesses).toBe(0)
    await until(() => !isRunning(before))
    const after = await children.run({ kind: 'pid' })
    expect(after).not.toBe(before)
    expect(children.liveProcesses).toBe(1)
  })

  it('子进程抛出：这个任务失败（crashed，cause 是抛出的错误），子进程被丢弃，下一个任务用新的子进程', async () => {
    const children = pool({ processes: 1 })
    const before = await children.run({ kind: 'pid' }) as number
    const error = await failure(children.run({ kind: 'throw' }))
    expect(error.reason).toBe('crashed')
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toContain('假任务按要求抛出')
    expect(children.liveProcesses).toBe(0)
    await until(() => !isRunning(before))
    expect(await children.run({ kind: 'pid' })).not.toBe(before)
  })

  it('子进程意外退出：这个任务失败（crashed，cause 带退出码），下一个任务照常', async () => {
    const children = pool({ processes: 1 })
    const error = await failure(children.run({ kind: 'exit' }))
    expect(error.reason).toBe('crashed')
    expect(exitOf(error)).toMatchObject({ exitCode: 3, signal: null })
    expect(await children.run({ kind: 'echo', value: 'again' })).toBe('again')
  })

  it('子进程的堆超过上限：V8 中止的只是那个子进程（out-of-memory），主进程照常，下一个任务用新的子进程', async () => {
    const children = pool({ processes: 1, heapMb: 64 })
    const before = await children.run({ kind: 'pid' }) as number
    // 上限确实加在子进程上：堆的上限是老生代（64 MiB）加新生代（3 个 16 MiB 的半区）；不设老生代时是几 GiB，不设半区时多出近 200 MiB
    const limit = await children.run({ kind: 'heap-limit' }) as number
    expect(limit).toBeGreaterThanOrEqual(64 * MIB)
    expect(limit).toBeLessThanOrEqual(128 * MIB)
    const error = await failure(children.run({ kind: 'allocate' }))
    expect(error.reason).toBe('out-of-memory')
    expect(exitOf(error).signal).toBe('SIGABRT')
    expect(exitOf(error).stderr).toContain('JavaScript heap out of memory')
    expect(isRunning(process.pid)).toBe(true)
    const after = await children.run({ kind: 'pid' })
    expect(after).not.toBe(before)
  })

  it.each([{ type: 'ready' }, null, 'result'])('子进程回了不该回的消息（%j）：丢弃它（crashed），主进程不抛出', async (message) => {
    const children = pool({ processes: 1 })
    const before = await children.run({ kind: 'pid' }) as number
    const error = await failure(children.run({ kind: 'stray', message }))
    expect(error.reason).toBe('crashed')
    expect((error.cause as Error).message).toContain('不该回的消息')
    await until(() => !isRunning(before))
    expect(await children.run({ kind: 'echo', value: 'next' })).toBe('next')
  })

  it('入口加载不了：任务失败（crashed，cause 带标准错误里的原因），不自己反复重建', async () => {
    const children = pool({ processes: 1, script: BROKEN_SCRIPT })
    const error = await failure(children.run({ kind: 'echo', value: 1 }))
    expect(error.reason).toBe('crashed')
    expect(exitOf(error).exitCode).toBe(1)
    expect(exitOf(error).stderr).toContain('假的入口按要求在加载时抛出')
    expect(children.liveProcesses).toBe(0)
    await sleep(200)
    expect(children.liveProcesses).toBe(0)
  })

  it('任务不能序列化：原样抛出，子进程照常留着', async () => {
    const children = pool({ processes: 1 })
    const pid = await children.run({ kind: 'pid' })
    await expect(children.run({ kind: 'echo', value: () => 1 })).rejects.toThrow(/could not be cloned/)
    expect(children.liveProcesses).toBe(1)
    expect(await children.run({ kind: 'pid' })).toBe(pid)
  })

  it('子进程在空闲时退出了（例如被系统结束）：丢弃它，下一个任务再起', async () => {
    const children = pool({ processes: 1 })
    const first = await children.run({ kind: 'pid' }) as number
    process.kill(first, 'SIGKILL')
    await until(() => children.liveProcesses === 0)
    expect(await children.run({ kind: 'pid' })).not.toBe(first)
  })

  it('空闲到期的子进程结束掉，下一个任务再起；执行任务的时间不算空闲', async () => {
    const children = pool({ processes: 1, idleTimeoutMs: 300 })
    const first = await children.run({ kind: 'pid' }) as number
    expect(await children.run({ kind: 'busy', ms: 600 })).toBe('done')
    expect(await children.run({ kind: 'pid' })).toBe(first)
    await until(() => children.liveProcesses === 0)
    await until(() => !isRunning(first))
    expect(await children.run({ kind: 'pid' })).not.toBe(first)
  })

  it('子进程不继承主进程的 Node 选项与环境变量：只带给的选项、堆与新生代的上限', async () => {
    const children = pool({ processes: 1, heapMb: 96, execArgv: ['--no-deprecation'] })
    expect(await children.run({ kind: 'echo', value: 1 })).toBe(1)
    const environment = await children.run({ kind: 'environment' }) as { execArgv: string[], env: string[] }
    expect(environment.execArgv).toEqual(['--max-old-space-size=96', '--max-semi-space-size=16', '--no-deprecation'])
    // 环境变量为空（macOS 在进程启动时自己加上 __CF_USER_TEXT_ENCODING，不是继承来的）
    expect(environment.env.filter(name => name !== '__CF_USER_TEXT_ENCODING')).toEqual([])
  })

  it('关闭：执行中与排队的任务都失败（closed），子进程都结束，之后的任务立即失败', async () => {
    const children = pool({ processes: 1, queue: { maxWaiting: 4 } })
    const blocking = gate()
    const running = failure(children.run({ kind: 'block', gate: blocking.directory }))
    await until(() => blocking.started().length === 1)
    const [pid] = blocking.started()
    const queued = failure(children.run({ kind: 'echo', value: 'queued' }))
    await children.close()
    expect((await running).reason).toBe('closed')
    expect((await queued).reason).toBe('closed')
    expect(children.liveProcesses).toBe(0)
    expect(isRunning(pid ?? 0)).toBe(false)
    expect((await failure(children.run({ kind: 'echo', value: 'after' }))).reason).toBe('closed')
  })

  it('子进程数与空闲的时限必须是正整数', () => {
    expect(() => pool({ processes: 0 })).toThrow(RangeError)
    expect(() => pool({ idleTimeoutMs: 0 })).toThrow(RangeError)
  })
})

/** 单独起一个 Node 进程执行 process-pool-parent.test-support.ts（真的主进程）：返回它，与它打印的每一行 JSON */
function parent(args: readonly string[]): { readonly child: ReturnType<typeof spawn>, readonly lines: unknown[], readonly exited: Promise<number | null> } {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', PARENT_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  const lines: unknown[] = []
  let buffered = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk
    const parts = buffered.split('\n')
    buffered = parts.pop() ?? ''
    lines.push(...parts.filter(line => line !== '').map(line => JSON.parse(line) as unknown))
  })
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)))
  return { child, lines, exited }
}

describe('子进程不留孤儿，空闲时不留住主进程（在一个真的主进程里）', SPAWNING, () => {
  it('有任务时留住主进程、空闲时不留：主进程打印完结果自己退出，子进程随 IPC 断开退出', async () => {
    const { lines, exited } = parent(['natural'])
    expect(await exited).toBe(0)
    expect(lines).toHaveLength(2)
    const { pid } = lines[0] as { pid: number }
    expect(pid).toEqual(expect.any(Number))
    expect(lines[1]).toEqual({ result: 'done' })
    await until(() => !isRunning(pid), 5_000)
  })

  it('关闭池子时留住主进程，直到子进程都退出', async () => {
    const { lines, exited } = parent(['close'])
    expect(await exited).toBe(0)
    expect(lines).toHaveLength(2)
    const { pid } = lines[0] as { pid: number }
    expect(lines[1]).toEqual({ closed: true })
    expect(isRunning(pid)).toBe(false)
  })

  it('主进程被强制结束（SIGKILL）：空闲的子进程立即退出；执行中的做完这一个之后退出', async () => {
    const blocking = gate()
    const { child, lines, exited } = parent(['orphan', blocking.directory])
    await until(() => lines.length === 1 && blocking.started().length === 1)
    const { pid: idle } = lines[0] as { pid: number }
    const [busy = 0] = blocking.started()
    child.kill('SIGKILL')
    await exited
    await until(() => !isRunning(idle), 5_000)
    // 执行中的子进程在同步地做事，做完之前顾不上 IPC 断开
    await sleep(200)
    expect(isRunning(busy)).toBe(true)
    blocking.release()
    await until(() => !isRunning(busy), 5_000)
  })
})
