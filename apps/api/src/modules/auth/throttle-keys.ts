// 限流的计数键（P3 设计 §3.5）：登录按"用户名 + 来源"、只按用户名、按客户端地址三个维度（M2-P6 复核 A1；来源的 IPv6 按 /48，
// 地址的 IPv6 按 /64，复验 N4）；一次性链接按地址（M2-P1），"找到了但不能用"另按链接的记录（M2-P6）。库里只存键的摘要。
import type { OneTimeLinkPurpose } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

/**
 * 账户维度（只按用户名，M2-P6 复核 A1）：规范化之后的用户名。它的摘要同时是"所属账户"（accountDigest）：
 * 账户相关的两个维度的计数行都记着它，按它一次清掉这个账户在所有来源上的计数。
 * 前缀与 M2-P6 之前的 `user:` 不同：之前的计数行（没有记所属账户）不再被认作任何维度，过期后照常清理
 */
export function accountKey(username: string): string {
  return `account:${username}`
}

/**
 * 账户与地址维度（M2-P6 复核 A1）：规范化之后的用户名加上来源的键（sourceKey48，IPv6 按 /48，复验 N4）。来源的键里没有 "|"、
 * 放在最后，从最后一个 "|" 分开就是原来的两部分：不同的（用户名，来源）不会拼出同一个键，即使用户名里有 "|"。
 * 前缀不变：来源的键自带粒度（`/48`；原来是 `/64`），同一个 IPv6 来源的新旧键本来就不同；IPv4 的粒度没变，键也不变
 */
export function accountAddressKey(username: string, clientIp: string | undefined): string {
  return `account-address:${username}|${sourceKey48(clientIp)}`
}

/**
 * 地址维度的键（登录的 `ip:`、一次性链接的 `link:`）：
 * - IPv4 按单个地址；IPv4 映射的 IPv6（双栈监听时的 `::ffff:a.b.c.d`）按其中的 IPv4；
 * - IPv6 按 /64：一台主机通常分到整个 /64，按单个地址计数，换个地址就绕过了；
 * - 取不到合法的地址时（连接已经断开、代理转发来的不是 IP）归到同一个键：宁可一起限流，也不能跳过这个维度。
 */
export function addressKey(clientIp: string | undefined): string {
  return keyOfAddress(parseClientAddress(clientIp), 4)
}

/**
 * "用户名 + 来源"这一维的来源键（复验 N4，需求方确认）：与 addressKey 相同，只是 IPv6 按 /48 聚合成一个来源。
 * 这一维每个来源只有几次（默认 5），只按用户名的宽上限（默认 50）却是这个账户在所有来源上合计的：来源分得越细，一个人能凑出的来源越多。
 * 家庭宽带常分到 /56、公司与云主机常是 /48，按 /64 一个人就能凑出几十个来源，把别人的账户在所有来源上锁住；
 * 按 /48，要从几十个不同的 /48 发请求。代价：同一个 /48 里的人（例如同一家公司）对同一个账户共用这几次。
 * 只按来源的地址维度（登录的 `ip:`、一次性链接的 `link:`）仍按 /64（addressKey），需求方确认不变
 */
export function sourceKey48(clientIp: string | undefined): string {
  return keyOfAddress(parseClientAddress(clientIp), 3)
}

/** 客户端地址：IPv4（包括 IPv4 映射的 IPv6 里的那个）是点分的文本，IPv6 是展开的 8 组；取不到合法的地址时为 undefined */
type ClientAddress = { readonly ipv4: string } | { readonly ipv6: readonly number[] } | undefined

function parseClientAddress(clientIp: string | undefined): ClientAddress {
  const address = clientIp?.split('%')[0]
  if (address !== undefined && isIPv4(address))
    return { ipv4: address }
  if (address === undefined || !isIPv6(address))
    return undefined
  const groups = ipv6Groups(address)
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xFFFF)
    return { ipv4: groups.slice(6).flatMap(group => [group >> 8, group & 0xFF]).join('.') }
  return { ipv6: groups }
}

/** 地址的键：IPv6 取前 prefixGroups 组（每组 16 位，4 组即 /64，3 组即 /48），写成 `前缀::/长度` */
function keyOfAddress(address: ClientAddress, prefixGroups: 3 | 4): string {
  if (address === undefined)
    return 'ip:unknown'
  if ('ipv4' in address)
    return `ip:${address.ipv4}`
  return `ip:${address.ipv6.slice(0, prefixGroups).map(group => group.toString(16)).join(':')}::/${prefixGroups * 16}`
}

/** 一次性链接的尝试（M2-P1 设计 §3.4）：同样按地址，另起前缀，与登录的地址维度分开计数 */
export function linkAddressKey(clientIp: string | undefined): string {
  return `link:${addressKey(clientIp)}`
}

/** 一次性链接"找到了但不能用"的次数（M2-P6）：按链接的记录（邀请或重置的 id）计数，不影响同一个地址的其他人与别的链接 */
export function linkRecordKey(purpose: OneTimeLinkPurpose, recordId: string): string {
  return `link-record:${purpose}:${recordId}`
}

export function keyDigest(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest()
}

/** 所属账户的摘要：账户维度的键的摘要（见 accountKey） */
export function accountDigest(username: string): Buffer {
  return keyDigest(accountKey(username))
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
