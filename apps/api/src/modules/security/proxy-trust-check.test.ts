import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { proxyTrustCheck, UNTRUSTED_PROXY_WARNING } from './proxy-trust-check.ts'

function requestOf(secure: boolean, headers: Record<string, string> = {}): Request {
  return { secure, headers, socket: { remoteAddress: '172.18.0.3' } } as unknown as Request
}

function setup(publicOrigin = 'https://office.example.com') {
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const warn = vi.spyOn(logger, 'warn')
  const check = proxyTrustCheck({ publicOrigin, trustProxy: false }, logger)
  const run = (request: Request): void => {
    const next = vi.fn()
    check(request, {} as Response, next)
    expect(next).toHaveBeenCalledOnce()
  }
  return { warn, run }
}

const FORWARDED = { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' }

describe('代理未被信任的自检（DEF-014）', () => {
  it('公开地址是 HTTPS，经代理转发来的请求却不是 HTTPS：告警，带着排查用的信息；每个进程只记一次，请求照常继续', () => {
    const { warn, run } = setup()
    run(requestOf(false, FORWARDED))
    run(requestOf(false, { 'x-forwarded-for': '203.0.113.8' }))
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(UNTRUSTED_PROXY_WARNING, {
      publicOrigin: 'https://office.example.com',
      trustProxy: false,
      peerAddress: '172.18.0.3',
      forwardedProto: 'https',
    })
  })

  it('只带其中一个转发头也算经过代理', () => {
    const { warn, run } = setup()
    run(requestOf(false, { 'x-forwarded-proto': 'https' }))
    expect(warn).toHaveBeenCalledOnce()
  })

  it('代理被信任（请求是 HTTPS），或者直接访问应用（不带转发头，例如容器的健康检查）：不告警', () => {
    const { warn, run } = setup()
    run(requestOf(true, FORWARDED))
    run(requestOf(false))
    expect(warn).not.toHaveBeenCalled()
  })

  it('公开地址是 HTTP（本机开发与测试）：不检查', () => {
    const { warn, run } = setup('http://127.0.0.1:5173')
    run(requestOf(false, FORWARDED))
    expect(warn).not.toHaveBeenCalled()
  })
})
