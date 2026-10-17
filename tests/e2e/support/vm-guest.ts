import type { VmResource } from './owned-vm-process.ts'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { connectGuestBoot } from './guest-connection.ts'

export type VmBrowser = 'chrome' | 'edge' | 'safari'
export interface VmGuestResource extends VmResource {
  readonly ssh: { readonly host?: string, readonly port: number, readonly user: string, readonly key: string, readonly knownHosts: string }
}
const execute = promisify(execFile)

export function guestQuote(value: string): string {
  return `'${value.replaceAll('\'', '\'"\'"\'')}'`
}

export async function connectVmGuest(resource: VmGuestResource) {
  const prefix = ['-F', '/dev/null', '-i', resource.ssh.key, '-p', String(resource.ssh.port), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', '-o', `HostKeyAlias=nerve-vm-${resource.resourceId}`, '-o', `UserKnownHostsFile=${resource.ssh.knownHosts}`]
  const { host, bootId } = await connectGuestBoot({
    address: async () => {
      if (resource.kind === 'tart')
        return (await execute(resource.executable, ['ip', resource.args[1]!, '--wait', '30'], { env: { ...process.env, ...resource.environment }, timeout: 40_000 })).stdout.trim()
      if (resource.ssh.host === undefined)
        throw new Error('缺少客体地址')
      return resource.ssh.host
    },
    readBoot: async host => (await execute('/usr/bin/ssh', [...prefix, `${resource.ssh.user}@${host}`, resource.kind === 'qemu' ? 'cat /proc/sys/kernel/random/boot_id' : '/usr/sbin/sysctl -n kern.bootsessionuuid'], { timeout: 10_000, maxBuffer: 8192 })).stdout,
    now: Date.now,
    wait: async () => { await delay(2000) },
    timeout: 600_000,
  })
  const args = [...prefix, `${resource.ssh.user}@${host}`]
  async function run(command: string, timeout = 30_000): Promise<string> {
    return (await execute('/usr/bin/ssh', [...args, command], { timeout, maxBuffer: 1024 * 1024 })).stdout.trim()
  }
  return {
    bootId,
    host,
    run,
    async clockSample() {
      const sentAt = Date.now()
      const guestAt = Number(await run(resource.kind === 'qemu'
        ? 'python3 -c \'import time; print(time.time_ns() // 1000000)\''
        : '/usr/bin/osascript -l JavaScript -e \'Date.now()\''))
      const receivedAt = Date.now()
      if (!Number.isSafeInteger(guestAt) || guestAt <= 0 || receivedAt < sentAt)
        throw new Error('客体时钟采样无效')
      return { sentAt, receivedAt, guestAt, offsetMin: sentAt - guestAt, offsetMax: receivedAt - guestAt }
    },
    async forward(url: string, log: string) {
      const target = new URL(url)
      if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || !/^\d+$/.test(target.port))
        throw new Error('客体转发只接受本次 loopback HTTP 收集器')
      const controlDirectory = await mkdtemp('/tmp/nerve-vm-ssh-')
      const socket = `${controlDirectory}/control`
      const fd = openSync(log, 'wx', 0o600)
      const child = spawn('/usr/bin/ssh', [...args.slice(0, -1), '-M', '-S', socket, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-N', '-R', `127.0.0.1:${target.port}:127.0.0.1:${target.port}`, args.at(-1)!], { stdio: ['ignore', fd, fd] })
      closeSync(fd)
      let failed: Error | undefined
      child.once('error', error => failed = error)
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.once('error', () => resolve())
      })
      let closing: Promise<void> | undefined
      const close = async (): Promise<void> => {
        closing ??= (async () => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGTERM')
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([exited, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('专用 SSH 转发未退出')), 5000)
            })])
            await rm(controlDirectory, { recursive: true })
          }
          finally {
            clearTimeout(timer)
          }
        })()
        return closing
      }
      try {
        const until = Date.now() + 30_000
        while (Date.now() < until) {
          if (failed !== undefined || child.exitCode !== null || child.signalCode !== null)
            throw new Error('专用 SSH 转发提前退出')
          try {
            // 本机 mux 接口只在该连接完成认证之后可用，避免同时开第二条连接抢跑。
            await execute('/usr/bin/ssh', [...args.slice(0, -1), '-S', socket, '-O', 'check', args.at(-1)!], { timeout: 2000 })
            await run(`curl --fail --silent --max-time 3 ${guestQuote(url)} >/dev/null`, 10_000)
            return { close }
          }
          catch {
            await delay(500)
          }
        }
        throw new Error('客体 loopback 转发未就绪')
      }
      catch (error) {
        await close()
        throw error
      }
    },
    async open(browser: VmBrowser, url: string) {
      const target = new URL(url)
      if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:')
        throw new Error('测试浏览器仅打开专用 loopback 来源')
      if (browser === 'safari') {
        if (resource.kind !== 'tart')
          throw new Error('Safari 必须在 macOS 客体运行')
        await run(`/usr/bin/open -a Safari ${guestQuote(url)}`)
        return
      }
      if (resource.kind !== 'qemu')
        throw new Error('Linux 正式浏览器必须在 QEMU 客体运行')
      await run('sudo systemctl is-active --quiet nerve-vm-xvfb || sudo systemd-run --unit=nerve-vm-xvfb --uid=ubuntu /usr/bin/Xvfb :99 -screen 0 1280x900x24 -nolisten tcp')
      const executable = browser === 'chrome' ? '/usr/bin/google-chrome' : '/usr/bin/microsoft-edge'
      await run(`sudo systemd-run --collect --unit=nerve-vm-browser-${randomUUID()} --uid=ubuntu --setenv=DISPLAY=:99 --setenv=HOME=/home/ubuntu ${executable} --user-data-dir=/home/ubuntu/nerve-vm/${browser} --no-first-run --no-default-browser-check --disable-gpu --password-store=basic ${guestQuote(url)}`)
    },
    async shutdown() {
      try {
        await run('sudo -n shutdown -h now', 10_000)
      }
      catch {
        // SSH 连接可能先于关机命令应答关闭；调用者仍必须核对 VM 正常退出。
      }
    },
  }
}
