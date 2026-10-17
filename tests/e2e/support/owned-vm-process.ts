import type { VmNativeIdentity, VmSignalReceipt } from './owned-vm.ts'
import type { VmBoot } from './vm-durability.ts'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { closeSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { createVmKillGuard } from './owned-vm.ts'

export interface VmResource {
  readonly resourceId: string
  readonly kind: 'qemu' | 'tart'
  readonly executable: string
  readonly args: readonly string[]
  readonly directory: string
  readonly disk: string
  readonly environment?: Readonly<Record<string, string>>
}

interface Exit { readonly code: number | null, readonly signal: NodeJS.Signals | null }

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function diskIdentity(path: string): VmBoot['disk'] {
  const canonical = realpathSync(path)
  const info = statSync(canonical)
  if (!info.isFile())
    throw new Error('VM 磁盘不是普通文件')
  return { path: canonical, device: info.dev, inode: info.ino }
}

function inside(directory: string, path: string): boolean {
  const child = relative(directory, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !child.startsWith(sep)
}

/** macOS 实验适配器；PID 只来自本次 spawn，外部页面不能选择进程。 */
export async function startOwnedVm(resource: VmResource, options: { readonly helper: string, readonly log: string }) {
  if (process.platform !== 'darwin' || !/^[0-9a-f-]{36}$/i.test(resource.resourceId))
    throw new Error('VM 控制仅接受 macOS 上的独立资源')
  const config = structuredClone(resource)
  const directory = realpathSync(config.directory)
  const executable = realpathSync(config.executable)
  const disk = diskIdentity(config.disk)
  if (!inside(directory, disk.path) || !inside(directory, options.log))
    throw new Error('VM 磁盘或日志不在独占资源目录内')
  if (config.kind === 'qemu') {
    if (basename(executable) !== 'qemu-system-x86_64' || !config.args.some(arg => arg.split(',').includes(`file=${disk.path}`)))
      throw new Error('QEMU 启动参数未绑定登记磁盘')
  }
  else if (config.kind === 'tart') {
    const home = config.environment?.TART_HOME
    if (basename(executable) !== 'tart' || config.args[0] !== 'run' || home === undefined || home === ''
      || realpathSync(join(home, 'vms', config.args[1] ?? '')) !== directory) {
      throw new Error('Tart 启动参数未绑定专用 VM')
    }
  }
  else {
    throw new Error('未知 VM 类型')
  }
  const helper = realpathSync(options.helper)
  const fd = openSync(options.log, 'wx', 0o600)
  const child = spawn(executable, [...config.args], {
    cwd: directory,
    env: { ...process.env, ...config.environment },
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  function native(mode: string, target?: VmNativeIdentity): unknown {
    const observedAt = Date.now()
    return JSON.parse(execFileSync(helper, target ? [mode] : ['read', String(child.pid)], {
      input: target ? JSON.stringify({ target, observedAt, deadline: observedAt + 2000 }) : undefined,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 8192,
    })) as unknown
  }
  let settled: Exit | undefined
  let rejectExit!: (error: Error) => void
  const exit = new Promise<Exit>((resolve, reject) => {
    rejectExit = reject
    child.once('exit', (code, signal) => {
      settled = { code, signal }
      resolve(settled)
    })
  })
  // spawn 失败的拒绝由启动者处理，后台退出 Promise 不产生未处理拒绝。
  void exit.catch(() => {})
  child.once('error', error => rejectExit(error))
  await once(child, 'spawn')
  const identity = native('read') as VmNativeIdentity
  if (identity.pid !== child.pid || identity.ppid !== process.pid || identity.uid !== process.getuid?.()
    || identity.executable !== executable || !/^\d+$/.test(identity.startedAtUs)) {
    throw new Error('本次 VM 子进程内核身份不匹配')
  }
  const command = execFileSync('/bin/ps', ['-ww', '-p', String(identity.pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).trim()
  const ownerPath = join(directory, `owned-${randomUUID()}.json`)
  writeFileSync(ownerPath, `${JSON.stringify({ config, identity, disk, command })}\n`, { flag: 'wx', mode: 0o600 })
  const ownerSha256 = sha256(readFileSync(ownerPath))
  let boot: VmBoot | undefined
  let guard: ReturnType<typeof createVmKillGuard> | undefined
  function capture() {
    return {
      running: settled === undefined && child.exitCode === null && child.signalCode === null,
      identity: native('read') as VmNativeIdentity,
      disk: diskIdentity(config.disk),
      command: execFileSync('/bin/ps', ['-ww', '-p', String(identity.pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).trim(),
      ownerSha256: sha256(readFileSync(ownerPath)),
    }
  }
  async function waitForExit(timeout = 10000): Promise<Exit> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([exit, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('VM 未在期限内退出')), timeout)
      })])
    }
    finally {
      clearTimeout(timer)
    }
  }
  return {
    identity: structuredClone(identity),
    ownerPath,
    registerGuestBoot(guestBootId: string): VmBoot {
      if (boot || !guestBootId || guestBootId.length > 128)
        throw new Error('客体启动身份无效或已登记')
      boot = { resourceId: config.resourceId, pid: identity.pid, uid: identity.uid, startedAt: identity.startedAtUs, guestBootId, disk }
      guard = createVmKillGuard({ identity, boot, command, ownerSha256 }, {
        capture,
        send: target => native('signal', target) as VmSignalReceipt,
        now: Date.now,
      })
      return structuredClone(boot)
    },
    async killAfter(receipt: unknown) {
      if (!guard)
        throw new Error('尚未登记客体启动身份')
      const signal = guard(receipt)
      const result = await waitForExit()
      if (result.code !== null || result.signal !== 'SIGKILL')
        throw new Error('VM 退出没有证实 SIGKILL')
      return { signal, exit: result }
    },
    waitForExit,
    async stopForCleanup() {
      if (settled)
        return settled
      // 清理不生成实验停止证明，也不在失败后追加 SIGKILL。
      if (!isDeepStrictEqual(native('read'), identity))
        throw new Error('清理时 VM 身份已经变化')
      native('normal-stop', identity)
      return waitForExit(30000)
    },
  }
}
