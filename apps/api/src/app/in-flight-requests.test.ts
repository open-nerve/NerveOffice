import type { Request, Response } from 'express'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { InFlightRequests } from './in-flight-requests.ts'

class FakeResponse extends EventEmitter {
  headersSent = false
  readonly headers = new Map<string, string>()

  setHeader(name: string, value: string): this {
    this.headers.set(name, value)
    return this
  }
}

function start(inFlight: InFlightRequests): FakeResponse {
  const response = new FakeResponse()
  let passed = false
  inFlight.middleware()({} as Request, response as unknown as Response, () => {
    passed = true
  })
  expect(passed).toBe(true)
  return response
}

describe('InFlightRequests', () => {
  it('每个请求计入，响应结束或连接关闭时移除', () => {
    const inFlight = new InFlightRequests()
    const first = start(inFlight)
    const second = start(inFlight)
    expect(inFlight.size).toBe(2)
    first.emit('finish')
    first.emit('close')
    second.emit('close')
    expect(inFlight.size).toBe(0)
  })

  it('在途请求都完成时 idle() 兑现；没有在途请求时立即兑现', async () => {
    const inFlight = new InFlightRequests()
    await inFlight.idle()
    const response = start(inFlight)
    let idle = false
    const waiting = inFlight.idle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    response.emit('finish')
    await waiting
    expect(idle).toBe(true)
  })

  it('开始退出后：还没发出响应头的在途响应与之后的响应都带 Connection: close', () => {
    const inFlight = new InFlightRequests()
    const pending = start(inFlight)
    const sent = start(inFlight)
    sent.headersSent = true
    inFlight.beginDraining()
    const later = start(inFlight)
    expect(pending.headers.get('Connection')).toBe('close')
    expect(sent.headers.has('Connection')).toBe(false)
    expect(later.headers.get('Connection')).toBe('close')
  })
})
