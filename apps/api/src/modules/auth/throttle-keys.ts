// 登录限流的计数键（P3 设计 §3.5）：按用户名与按客户端地址两个维度。库里只存键的摘要。
import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

export function usernameKey(username: string): string {
  return `user:${username}`
}

/**
 * 地址维度的键：
 * - IPv4 按单个地址；IPv4 映射的 IPv6（双栈监听时的 `::ffff:a.b.c.d`）按其中的 IPv4；
 * - IPv6 按 /64：一台主机通常分到整个 /64，按单个地址计数，换个地址就绕过了；
 * - 取不到合法的地址时（连接已经断开、代理转发来的不是 IP）归到同一个键：宁可一起限流，也不能跳过这个维度。
 */
export function addressKey(clientIp: string | undefined): string {
  const address = clientIp?.split('%')[0]
  if (address !== undefined && isIPv4(address))
    return `ip:${address}`
  if (address === undefined || !isIPv6(address))
    return 'ip:unknown'
  const groups = ipv6Groups(address)
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xFFFF)
    return `ip:${groups.slice(6).flatMap(group => [group >> 8, group & 0xFF]).join('.')}`
  return `ip:${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`
}

export function keyDigest(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest()
}

/** 把合法的 IPv6 文本展开成 8 组 16 位的数；末尾可以是内嵌的 IPv4（`::ffff:1.2.3.4`）。 */
function ipv6Groups(address: string): number[] {
  let text = address
  const tailStart = text.lastIndexOf(':') + 1
  const tail = text.slice(tailStart)
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number)
    text = `${text.slice(0, tailStart)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', rest] = text.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = rest === undefined || rest === '' ? [] : rest.split(':')
  const zeros = rest === undefined ? [] : Array.from<string>({ length: 8 - left.length - right.length }).fill('0')
  return [...left, ...zeros, ...right].map(group => Number.parseInt(group, 16))
}
