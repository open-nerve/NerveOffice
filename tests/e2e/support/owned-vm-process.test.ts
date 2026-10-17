import type { MockInstance } from 'vitest'
import type { VmNativeIdentity } from './owned-vm.ts'
import { ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startOwnedVm } from './owned-vm-process.ts'

// 只替换进程/内核边界，不启动 VM 或发送真实信号；目录和登记文件使用实际临时文件。
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(), execFileSync: vi.fn() }
})
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), readFileSync: vi.fn(actual.readFileSync) }
})
vi.mock('node:process', async (original) => {
  const actual = await original<{ default: NodeJS.Process }>()
  return { ...actual, default: { ...actual.default, platform: 'darwin' } }
})

let directory: string
let child: ChildProcess
let identity: VmNativeIdentity
let autoExit: boolean
let stop: MockInstance<ChildProcess['kill']>

function exited(signal: NodeJS.Signals = 'SIGINT') {
  Object.assign(child, { signalCode: signal })
  child.emit('exit', null, signal)
}

async function launch() {
  return startOwnedVm({
    resourceId: '7f1f40c3-1579-4657-9902-9f1f804fdde1',
    kind: 'qemu',
    executable: identity.executable,
    directory,
    disk: join(directory, 'disk.img'),
    args: ['-drive', `file=${join(directory, 'disk.img')}`],
  }, { helper: join(directory, 'helper'), log: join(directory, 'vm.log') })
}

beforeEach(() => {
  vi.clearAllMocks()
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'nerve-vm-startup-')))
  for (const name of ['qemu-system-x86_64', 'disk.img', 'helper'])
    writeFileSync(join(directory, name), '')
  child = new ChildProcess()
  Object.assign(child, { pid: 81234 })
  identity = { pid: 81234, ppid: process.pid, uid: process.getuid!(), startedAtUs: '123456789000', executable: join(directory, 'qemu-system-x86_64') }
  autoExit = true
  stop = vi.spyOn(child, 'kill').mockImplementation((signal) => {
    if (autoExit)
      queueMicrotask(() => exited(signal as NodeJS.Signals))
    return true
  })
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  vi.mocked(execFileSync).mockImplementation((file, args) => {
    if (file === '/bin/ps')
      return `${identity.executable} -drive file=${join(directory, 'disk.img')}`
    if (file === join(directory, 'helper') && Array.isArray(args) && args[0] === 'read')
      return JSON.stringify(identity)
    if (file === join(directory, 'helper') && Array.isArray(args) && args[0] === 'normal-stop') {
      queueMicrotask(() => exited())
      return JSON.stringify({ kind: 'cleanup', signal: 'SIGINT', signalsSent: 1 })
    }
    throw new Error('不允许其他进程操作')
  })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

describe('VM 启动资格失败由创建者收回本次子进程', () => {
  it.each(['native-read', 'ps', 'owner-write', 'owner-read'] as const)('%s 抛错仍先正常停止本次子进程，再返回原始失败', async (stage) => {
    const failure = new Error(stage)
    if (stage === 'native-read') {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw failure
      })
    }
    if (stage === 'ps') {
      vi.mocked(execFileSync).mockImplementationOnce(() => JSON.stringify(identity)).mockImplementationOnce(() => {
        throw failure
      })
    }
    if (stage === 'owner-write') {
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw failure
      })
    }
    if (stage === 'owner-read') {
      vi.mocked(readFileSync).mockImplementationOnce(() => {
        throw failure
      })
    }
    await expect(launch()).rejects.toBe(failure)
    expect(stop).toHaveBeenCalledExactlyOnceWith('SIGINT')
    expect(child.signalCode).toBe('SIGINT')
  })

  it('身份字段不匹配也只收回创建的句柄，不向错误报告里的 PID 发信号', async () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => JSON.stringify({ ...identity, pid: 99999 }))
    await expect(launch()).rejects.toThrow('身份不匹配')
    expect(stop).toHaveBeenCalledExactlyOnceWith('SIGINT')
    expect(vi.mocked(execFileSync).mock.calls).toHaveLength(1)
  })

  it('已观察到子进程退出时不再发送清理信号', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => {
        child.emit('spawn')
        exited('SIGTERM')
      })
      return child
    })
    const failure = new Error('已退出，内核身份不存在')
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw failure
    })
    await expect(launch()).rejects.toBe(failure)
    expect(stop).not.toHaveBeenCalled()
  })

  it('没有实际启动的 error 事件不会触发清理信号', async () => {
    const failure = new Error('spawn ENOENT')
    Object.assign(child, { pid: undefined })
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('error', failure))
      return child
    })
    await expect(launch()).rejects.toBe(failure)
    expect(stop).not.toHaveBeenCalled()
  })

  it('清理尚未退出时不提前把启动失败交还调用方', async () => {
    autoExit = false
    const failure = new Error('native read failed')
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw failure
    })
    let finished = false
    const result = launch().catch((error: unknown) => {
      finished = true
      return error
    })
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    expect(finished).toBe(false)
    exited()
    expect(await result).toBe(failure)
  })

  it('清理信号失败同时保留启动原错与清理错误，不升级为强杀', async () => {
    const failure = new Error('owner registration failed')
    const cleanup = new Error('signal failed')
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw failure
    })
    stop.mockImplementation(() => {
      throw cleanup
    })
    const error = await launch().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([failure, cleanup])
    expect((error as AggregateError).message).toContain('owner registration failed')
    expect((error as AggregateError).message).toContain('signal failed')
    expect((error as AggregateError).message).toContain('81234')
    expect(stop).toHaveBeenCalledExactlyOnceWith('SIGINT')
  })

  it('清理退出超时保留两种失败，不再次发信号或伪造实验停止证明', async () => {
    vi.useFakeTimers()
    autoExit = false
    const failure = new Error('native read failed')
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw failure
    })
    const result = launch().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30001)
    const error = await result
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBe(failure)
    expect((error as AggregateError).errors[1]).toBeInstanceOf(Error)
    expect(stop).toHaveBeenCalledExactlyOnceWith('SIGINT')
    expect(child.signalCode).toBeNull()
  })

  it('资格完成返回可用句柄，正常清理仍走原生身份复核', async () => {
    const vm = await launch()
    expect(vm.identity).toEqual(identity)
    expect(JSON.parse(readFileSync(vm.ownerPath, 'utf8'))).toMatchObject({ identity })
    expect(stop).not.toHaveBeenCalled()
    expect(await vm.stopForCleanup()).toEqual({ code: null, signal: 'SIGINT' })
    expect(stop).not.toHaveBeenCalled()
    expect(vi.mocked(execFileSync).mock.calls.at(-1)?.[1]).toEqual(['normal-stop'])
  })
})
