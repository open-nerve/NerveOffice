import { describe, expect, it } from 'vitest'
import { accountAddressKey, accountDigest, accountKey, addressKey, keyDigest, linkAddressKey, linkRecordKey, sourceKey48 } from './throttle-keys.ts'

/**
 * 同一个 /48（2001:db8:1::/48，文档专用的前缀）里不同的 /64：第 4 组的高 8 位、低 8 位各有不同，
 * 按 /56 聚合（只看高 8 位）与按 /64 聚合时，它们都不全是同一个来源
 */
const SAME_48 = ['2001:db8:1:1::1', '2001:db8:1:2::abcd', '2001:db8:1:100::1', '2001:db8:1:ffff:ffff:ffff:ffff:ffff'] as const

describe('登录限流的计数键', () => {
  it('账户维度（M2-P6 复核 A1）：规范化之后的用户名；前缀与之前只按用户名的 user: 不同，之前的计数行不会被认作它', () => {
    expect(accountKey('alice')).toBe('account:alice')
    expect(accountKey('alice')).not.toBe('user:alice')
  })

  it('账户与地址维度：用户名加上来源的键，同一个人换一个来源是另一个键', () => {
    expect(accountAddressKey('alice', '203.0.113.7')).toBe('account-address:alice|ip:203.0.113.7')
    expect(accountAddressKey('alice', '2001:db8:1:2::1')).toBe('account-address:alice|ip:2001:db8:1::/48')
    expect(accountAddressKey('alice', '203.0.113.8')).not.toBe(accountAddressKey('alice', '203.0.113.7'))
    expect(accountAddressKey('alice', undefined)).toBe('account-address:alice|ip:unknown')
  })

  it('账户与地址维度的来源按 /48（复验 N4）：同一个 /48 里不同的 /64 是同一个来源，共用那几次；不同的 /48 各算各的', () => {
    for (const address of SAME_48)
      expect(accountAddressKey('alice', address), address).toBe(accountAddressKey('alice', SAME_48[0]))
    expect(accountAddressKey('alice', '2001:db8:2::1')).not.toBe(accountAddressKey('alice', SAME_48[0]))
    expect(accountAddressKey('alice', '2001:db8:0:ffff::1')).not.toBe(accountAddressKey('alice', SAME_48[0]))
  })

  it('账户与地址维度：用户名里有 "|" 也不会与别的（用户名，来源）拼出同一个键（来源的键里没有 "|"，放在最后）', () => {
    // 登录时的用户名是用户输入的原文（规范化之后），什么字符都可能有
    const tricky = accountAddressKey('alice|ip:203.0.113.7', '198.51.100.1')
    expect(tricky).not.toBe(accountAddressKey('alice', '203.0.113.7'))
    expect(tricky.slice(tricky.lastIndexOf('|') + 1)).toBe(sourceKey48('198.51.100.1'))
  })

  it('来源的键（复验 N4）：IPv6 按 /48 写成前缀；IPv4 按单个地址，IPv4 映射的 IPv6 按其中的 IPv4；取不到合法地址时归到同一个键', () => {
    expect(sourceKey48('2001:db8:1:2::1')).toBe('ip:2001:db8:1::/48')
    expect(sourceKey48('2001:0DB8:0001:ffff:0:0:0:9')).toBe('ip:2001:db8:1::/48')
    expect(sourceKey48('::1')).toBe('ip:0:0:0::/48')
    expect(sourceKey48('fe80::1%eth0')).toBe(sourceKey48('fe80::2'))
    expect(sourceKey48('203.0.113.7')).toBe('ip:203.0.113.7')
    expect(sourceKey48('203.0.113.8')).not.toBe(sourceKey48('203.0.113.7'))
    expect(sourceKey48('::ffff:203.0.113.7')).toBe('ip:203.0.113.7')
    expect(sourceKey48('::ffff:cb00:7107')).toBe('ip:203.0.113.7')
    for (const value of [undefined, '', 'not-an-ip', '999.1.1.1'])
      expect(sourceKey48(value), String(value)).toBe('ip:unknown')
  })

  it('地址维度仍按 /64（复验 N4 只改来源这一维）：同一个 /48 里不同的 /64 是不同的地址', () => {
    expect(new Set(SAME_48.map(address => addressKey(address))).size).toBe(SAME_48.length)
    expect(new Set(SAME_48.map(address => linkAddressKey(address))).size).toBe(SAME_48.length)
  })

  it('所属账户的摘要就是账户维度的键的摘要：两个账户相关的维度的计数行都记着它', () => {
    expect(accountDigest('alice').equals(keyDigest('account:alice'))).toBe(true)
    expect(accountDigest('alice').equals(accountDigest('bob'))).toBe(false)
  })

  it('一次性链接：按地址另起前缀；"找到了但不能用"按用途与记录（M2-P6），不同记录、不同用途都是不同的键', () => {
    expect(linkAddressKey('203.0.113.7')).toBe('link:ip:203.0.113.7')
    const id = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
    expect(linkRecordKey('invitation', id)).toBe(`link-record:invitation:${id}`)
    expect(linkRecordKey('password_reset', id)).not.toBe(linkRecordKey('invitation', id))
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
