import type { ImageRunnerOptions } from './image-runner.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageProcessingEntry, ImageRunner } from './image-runner.ts'

const runners: ImageRunner[] = []
const directories: string[] = []
const signal = (): AbortSignal => new AbortController().signal
const input = (kind = 'ok', delay?: number) => ({ data: Buffer.from(JSON.stringify({ kind, delay })), mimeType: 'image/png' as const, extension: 'png' as const })
const busy = { code: 'ASSET_BUSY', headers: { 'Retry-After': '10' } }
const tooComplex = { code: 'ASSET_INVALID', details: { rule: 'too-complex' } }
const realTimeout = setTimeout

function create(mode = 'normal', overrides: Partial<ImageRunnerOptions> = {}) {
  const trace = mkdtempSync(join(tmpdir(), 'image-runner-'))
  directories.push(trace)
  const runner = new ImageRunner({ entry: { script: new URL('./image-runner-child.test-support.mjs', import.meta.url), args: [trace, mode] }, ...overrides })
  runners.push(runner)
  const started = () => readdirSync(trace).filter(n => n.startsWith('started-')).map(n => Number(n.slice(8)))
  const tasks = () => readdirSync(trace).filter(n => n.startsWith('task-')).map(n => JSON.parse(readFileSync(join(trace, n), 'utf8')) as { pid: number, environment: Record<string, string>, execArgv: string[] })
  return { runner, trace, started, tasks }
}
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch { return false }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!check()) {
    if (performance.now() > deadline)
      throw new Error('等不到测试进程的状态')
    await new Promise(resolve => realTimeout(resolve, 10))
  }
}
afterEach(async () => {
  await Promise.all(runners.splice(0).map(async runner => runner.close()))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('图片一次性进程', { timeout: 30_000 }, () => {
  it('源码/生产运行都定位正式 JS，不能在 jitless 下退回 TS', () => {
    expect(imageProcessingEntry('file:///repo/apps/api/src/modules/assets/image-runner.ts').script.href).toBe('file:///repo/apps/api/dist/modules/assets/image-processing.child.js')
    expect(imageProcessingEntry('file:///app/dist/modules/assets/image-runner.js').script.href).toBe('file:///app/dist/modules/assets/image-processing.child.js')
  })

  it('启动先做能力探测，每次任务用不同 PID，返回前均已回收', async () => {
    const { runner, started, tasks } = create()
    await expect(runner.process(input(), signal())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await runner.initialize()
    await runner.initialize()
    expect(started()).toHaveLength(1)
    expect(started().every(pid => !running(pid))).toBe(true)
    for (let i = 0; i < 2; i++) {
      expect(await runner.process(input(), signal())).toMatchObject({ mimeType: 'image/png', width: 1, height: 1, frames: 1 })
      expect(runner.liveProcesses).toBe(0)
      expect(started().every(pid => !running(pid))).toBe(true)
    }
    expect(new Set(tasks().map(t => t.pid)).size).toBe(2)
  })

  it('秘密与 NODE_OPTIONS 不继承，固定堆/半区/jitless 生效', async () => {
    const { runner, tasks } = create()
    vi.stubEnv('NODE_OPTIONS', '--import=file:///must-not-load.mjs')
    vi.stubEnv('NERVE_DATABASE_URL', 'dummy-private-connection')
    await runner.initialize()
    await runner.process(input(), signal())
    const environment = { ...tasks()[0]!.environment }
    // macOS 空环境控制组也出现此系统编码字段；只放行它，不忽略任意其他变量。
    if (process.platform === 'darwin' && '__CF_USER_TEXT_ENCODING' in environment) {
      expect(environment.__CF_USER_TEXT_ENCODING).toMatch(/^0x[\da-f]+:0x[\da-f]+:0x[\da-f]+$/i)
      delete environment.__CF_USER_TEXT_ENCODING
    }
    expect(environment).toEqual({ MALLOC_ARENA_MAX: '2', UV_THREADPOOL_SIZE: '1', VIPS_DISC_THRESHOLD: '256m' })
    expect(tasks()[0]!.execArgv).toEqual(['--jitless', '--max-old-space-size=128', '--max-semi-space-size=16'])
  })

  it.each(['exit', 'disconnect', 'bad', 'bad-rule', 'double', 'failed', 'generic-memory-text'])('%s 为通用服务错误，原始字节/路径/stderr 不外泄；下一份恢复', async (kind) => {
    const { runner, started } = create()
    await runner.initialize()
    const error: unknown = await runner.process(input(kind), signal()).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(JSON.stringify(error)).not.toMatch(/private|secret|Allocation failed/)
    expect(started().every(pid => !running(pid))).toBe(true)
    expect(await runner.process(input(), signal())).toHaveProperty('sha256')
  })

  it('处理器的有限拒绝规则保留为 422，坏规则不能穿透', async () => {
    const { runner } = create()
    await runner.initialize()
    await expect(runner.process(input('invalid'), signal())).rejects.toMatchObject({ code: 'ASSET_INVALID', details: { rule: 'pixels' } })
    expect(await runner.process(input(), signal())).toHaveProperty('sha256')
  })

  it('整个启动和处理共用一个 deadline，超时先回收，再接受下一份', async () => {
    const { runner, trace, tasks, started } = create('gated-ready')
    const readyFile = join(trace, 'release-ready')
    writeFileSync(readyFile, '')
    await runner.initialize()
    rmSync(readyFile)
    // 真实子进程的 ready 由文件闸门控制；只快进父进程计时器，不依赖机器启动速度。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const task = runner.process(input('hang'), signal())
    const rejected = expect(task).rejects.toMatchObject(tooComplex)
    await until(() => started().length === 2)
    await vi.advanceTimersByTimeAsync(2500)
    writeFileSync(readyFile, '')
    await until(() => tasks().length === 1)
    await vi.advanceTimersByTimeAsync(2500)
    await rejected
    expect(started().every(pid => !running(pid))).toBe(true)
    vi.useRealTimers()
    expect(await runner.process(input(), signal())).toHaveProperty('sha256')
  })

  it('V8 真实堆耗尽是 too-complex，回收后下一份恢复', async () => {
    const { runner, started } = create()
    await runner.initialize()
    await expect(runner.process(input('heap'), signal())).rejects.toMatchObject(tooComplex)
    expect(started().every(pid => !running(pid))).toBe(true)
    expect(await runner.process(input(), signal())).toHaveProperty('sha256')
  })

  it('直接并发调用不重复排队；取消正在执行的任务先回收', async () => {
    const { runner, tasks, started } = create()
    await runner.initialize()
    const controller = new AbortController()
    const task = runner.process(input('hang'), controller.signal)
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    await until(() => tasks().length === 1)
    await expect(runner.process(input(), signal())).rejects.toMatchObject(busy)
    controller.abort('private-body')
    await rejected
    expect(started().every(pid => !running(pid))).toBe(true)
    expect(await runner.process(input(), signal())).toHaveProperty('sha256')
  })

  it('关闭回收在途进程，幂等且不再接受任务', async () => {
    const { runner, tasks, started } = create()
    await runner.initialize()
    const task = runner.process(input('hang'), signal())
    const rejected = expect(task).rejects.toMatchObject(busy)
    await until(() => tasks().length === 1)
    await runner.close()
    await rejected
    await runner.close()
    expect(started().every(pid => !running(pid))).toBe(true)
    await expect(runner.process(input(), signal())).rejects.toMatchObject(busy)
  })

  it('加载失败/从不 ready 拒绝初始化，不伪装成功，也不降级', async () => {
    const never = create('never-ready', { executionMs: 150 })
    await expect(never.runner.initialize()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(never.started().every(pid => !running(pid))).toBe(true)
    const missing = create('normal', { entry: { script: new URL('file:///missing-image-child.js') } })
    await expect(missing.runner.initialize()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(missing.runner.process(input(), signal())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('初始化中关闭也会回收；不能在 close 后重新变成可用', async () => {
    const { runner, started } = create('never-ready')
    const initializing = runner.initialize()
    const rejected = expect(initializing).rejects.toMatchObject(busy)
    await until(() => started().length === 1)
    await runner.close()
    await rejected
    expect(started().every(pid => !running(pid))).toBe(true)
    await expect(runner.initialize()).rejects.toMatchObject(busy)
  })

  it('调用后改写输入不影响已交出的副本；预先取消/超长正文不创建进程', async () => {
    const { runner, started } = create()
    await runner.initialize()
    const controller = new AbortController()
    controller.abort()
    await expect(runner.process(input(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(runner.process({ ...input(), data: Buffer.alloc(5 * 1024 * 1024 + 1) }, signal())).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(started()).toHaveLength(1)
    const mutable = input()
    const processed = runner.process(mutable, signal())
    mutable.data.fill(0)
    expect(await processed).toHaveProperty('sha256')
  })

  it('外部 SIGKILL 是不可归因的退出，不仅凭信号断言 OOM；下一份恢复', async () => {
    const { runner, tasks } = create()
    await runner.initialize()
    const task = runner.process(input('hang'), signal())
    const rejected = expect(task).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', reason: 'crashed' })
    await until(() => tasks().length === 1)
    process.kill(tasks()[0]!.pid, 'SIGKILL')
    await rejected
    expect(await runner.process(input(), signal())).toHaveProperty('sha256')
  })

  it('父进程被强制结束后 IPC 断开，受控任务不成为孤儿', async () => {
    const trace = mkdtempSync(join(tmpdir(), 'image-parent-'))
    directories.push(trace)
    const parent = spawn(process.execPath, ['--experimental-transform-types', '--conditions=@nerve-office/source', fileURLToPath(new URL('./image-runner-parent.test-support.ts', import.meta.url)), trace], { env: {}, stdio: 'ignore' })
    const exited = new Promise<void>((resolve, reject) => {
      parent.once('close', () => resolve())
      parent.once('error', reject)
    })
    try {
      await until(() => readdirSync(trace).some(n => n.startsWith('task-')))
      const pid = Number(readdirSync(trace).find(n => n.startsWith('task-'))!.slice(5, -5))
      expect(running(pid)).toBe(true)
      parent.kill('SIGKILL')
      await exited
      await until(() => !running(pid))
    }
    finally {
      parent.kill('SIGKILL')
      await exited
    }
  })
})
