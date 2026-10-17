import { isIP } from 'node:net'

interface GuestConnectionPorts {
  readonly address: () => Promise<string>
  readonly readBoot: (host: string) => Promise<string>
  readonly now: () => number
  readonly wait: () => Promise<void>
  readonly timeout: number
}

/** VM 重启可能换 DHCP 地址；每次重试必须重新解析，不能固定第一次的旧租约。 */
export async function connectGuestBoot(ports: GuestConnectionPorts) {
  const startedAt = ports.now()
  const deadline = startedAt + ports.timeout
  while (ports.now() >= startedAt && ports.now() < deadline) {
    try {
      const host = await ports.address()
      if (isIP(host) !== 4)
        throw new Error('客体地址无效')
      const bootId = (await ports.readBoot(host)).trim()
      const now = ports.now()
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootId) && now >= startedAt && now < deadline)
        return { host, bootId }
    }
    catch {
      // 地址租约和 SSH 就绪各有时序；下一次从地址解析重新开始。
    }
    await ports.wait()
  }
  throw new Error('客体 SSH 或启动身份未在期限内就绪')
}
