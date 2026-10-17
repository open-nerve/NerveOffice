import { describe, expect, it } from 'vitest'
import { connectGuestBoot } from './guest-connection.ts'

describe('客体重启连接', () => {
  const bootId = '11111111-2222-4333-8444-555555555555'

  it('旧 DHCP 地址不可达后重新解析地址，只有新地址的实际启动身份才能返回', async () => {
    const addresses = ['192.168.128.2', '192.168.129.2']
    const attempted: string[] = []
    let now = 0
    const result = await connectGuestBoot({
      address: async () => addresses.shift()!,
      readBoot: async (host) => {
        attempted.push(host)
        if (host === '192.168.128.2')
          throw new Error('旧地址不可达')
        return bootId
      },
      now: () => now,
      wait: async () => { now += 10 },
      timeout: 100,
    })
    expect(result).toEqual({ host: '192.168.129.2', bootId })
    expect(attempted).toEqual(['192.168.128.2', '192.168.129.2'])
  })

  it('非法地址不能交给 SSH，非法启动身份不能获得资格', async () => {
    const addresses = ['host.invalid', '999.1.2.3', '127.0.0.1', '127.0.0.1']
    let now = 0
    const attempted: string[] = []
    const result = await connectGuestBoot({
      address: async () => addresses.shift()!,
      readBoot: async (host) => {
        attempted.push(host)
        return attempted.length === 1 ? 'not-a-boot' : bootId
      },
      now: () => now,
      wait: async () => { now += 10 },
      timeout: 100,
    })
    expect(result).toEqual({ host: '127.0.0.1', bootId })
    expect(attempted).toEqual(['127.0.0.1', '127.0.0.1'])
  })

  it('解析失败或一直连接失败在期限结束后拒绝，不产生假的启动证明', async () => {
    let now = 0
    let calls = 0
    await expect(connectGuestBoot({
      address: async () => { throw new Error('没有 DHCP 记录') },
      readBoot: async () => {
        calls += 1
        return bootId
      },
      now: () => now,
      wait: async () => { now += 10 },
      timeout: 30,
    })).rejects.toThrow('期限')
    expect(calls).toBe(0)
  })

  it('迟于期限到达的有效启动身份也不能接受', async () => {
    let now = 0
    await expect(connectGuestBoot({
      address: async () => '127.0.0.1',
      readBoot: async () => {
        now = 31
        return bootId
      },
      now: () => now,
      wait: async () => {},
      timeout: 30,
    })).rejects.toThrow('期限')
  })
})
