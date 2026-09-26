import type { CallHandler, ExecutionContext } from '@nestjs/common'
import type { Request, Response } from 'express'
import { EventEmitter } from 'node:events'
import { Subject } from 'rxjs'
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

/** 进入处理器：返回让处理器"结束"的函数。 */
function enterHandler(inFlight: InFlightRequests): () => void {
  const result = new Subject<unknown>()
  inFlight.interceptor().intercept({} as ExecutionContext, { handle: () => result } as CallHandler).subscribe()
  return () => result.complete()
}

async function isIdle(inFlight: InFlightRequests): Promise<boolean> {
  let idle = false
  void inFlight.idle().then(() => {
    idle = true
  })
  await new Promise(resolve => setImmediate(resolve))
  return idle
}

describe('InFlightRequests', () => {
  it('每个请求计入，响应结束或连接关闭时移除', () => {
    const inFlight = new InFlightRequests()
    const first = start(inFlight)
    const second = start(inFlight)
    expect(inFlight.pending).toEqual({ responses: 2, handlers: 0 })
    first.emit('finish')
    first.emit('close')
    second.emit('close')
    expect(inFlight.pending).toEqual({ responses: 0, handlers: 0 })
  })

  it('没有在途请求时 idle() 立即兑现；响应结束后兑现', async () => {
    const inFlight = new InFlightRequests()
    expect(await isIdle(inFlight)).toBe(true)
    const response = start(inFlight)
    expect(await isIdle(inFlight)).toBe(false)
    response.emit('finish')
    expect(await isIdle(inFlight)).toBe(true)
  })

  it('客户端中途断开（响应先关闭）时，要等处理器结束才算排空', async () => {
    const inFlight = new InFlightRequests()
    const response = start(inFlight)
    const finishHandler = enterHandler(inFlight)
    response.emit('close')
    expect(inFlight.pending).toEqual({ responses: 0, handlers: 1 })
    expect(await isIdle(inFlight)).toBe(false)
    finishHandler()
    expect(await isIdle(inFlight)).toBe(true)
  })

  it('处理器出错同样计出', async () => {
    const inFlight = new InFlightRequests()
    const result = new Subject<unknown>()
    inFlight.interceptor().intercept({} as ExecutionContext, { handle: () => result } as CallHandler).subscribe({ error: () => {} })
    result.error(new Error('处理失败'))
    expect(inFlight.pending.handlers).toBe(0)
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
