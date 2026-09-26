import { describe, expect, it } from 'vitest'
import { addressKey, keyDigest, usernameKey } from './throttle-keys.ts'

describe('登录限流的计数键', () => {
  it('用户名维度：规范化之后的用户名', () => {
    expect(usernameKey('alice')).toBe('user:alice')
  })

  it('IPv4 按单个地址', () => {
    expect(addressKey('203.0.113.7')).toBe('ip:203.0.113.7')
    expect(addressKey('203.0.113.8')).not.toBe(addressKey('203.0.113.7'))
  })

  it('IPv4 映射的 IPv6（双栈监听）按其中的 IPv4，与直接的 IPv4 是同一个键', () => {
    expect(addressKey('::ffff:203.0.113.7')).toBe('ip:203.0.113.7')
    expect(addressKey('::ffff:cb00:7107')).toBe('ip:203.0.113.7')
  })

  it('IPv6 按 /64：同一个 /64 里换地址还是同一个键，不同的 /64 不同', () => {
    const key = addressKey('2001:db8:1:2::1')
    expect(key).toBe('ip:2001:db8:1:2::/64')
    for (const address of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:0db8:0001:0002:0:0:0:9', '2001:DB8:1:2::abcd'])
      expect(addressKey(address), address).toBe(key)
    expect(addressKey('2001:db8:1:3::1')).not.toBe(key)
  })

  it('各种省略写法都能展开', () => {
    expect(addressKey('::1')).toBe('ip:0:0:0:0::/64')
    expect(addressKey('::')).toBe('ip:0:0:0:0::/64')
    expect(addressKey('fe80::')).toBe('ip:fe80:0:0:0::/64')
    expect(addressKey('1:2:3:4:5:6:7:8')).toBe('ip:1:2:3:4::/64')
    expect(addressKey('64:ff9b::192.0.2.33')).toBe('ip:64:ff9b:0:0::/64')
  })

  it('带作用域的 IPv6 去掉作用域再算', () => {
    expect(addressKey('fe80::1%eth0')).toBe(addressKey('fe80::2'))
  })

  it('取不到合法地址时归到同一个键，不跳过这个维度', () => {
    for (const value of [undefined, '', 'not-an-ip', 'unknown', '999.1.1.1'])
      expect(addressKey(value), String(value)).toBe('ip:unknown')
  })

  it('摘要是 32 字节的 SHA-256：库里不存原文', () => {
    expect(keyDigest('user:alice')).toHaveLength(32)
    expect(keyDigest('user:alice').equals(keyDigest('user:alice'))).toBe(true)
    expect(keyDigest('user:alice').equals(keyDigest('user:bob'))).toBe(false)
  })
})
