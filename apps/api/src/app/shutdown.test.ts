import type { ShutdownSteps } from './shutdown.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootLogger } from '../modules/logging/index.ts'
import { InFlightRequests } from './in-flight-requests.ts'
import { shutdownGracefully } from './shutdown.ts'

/** 假的 HTTP 服务器：close() 的回调在 closeIdleConnections() 或 closeAllConnections() 之后调用，模拟连接都关闭了。 */
function fakeServer(events: string[], closesWhenIdle = true) {
  let onClosed: (() => void) | undefined
  return {
    close: vi.fn((callback: () => void) => {
      events.push('close')
      onClosed = callback
    }),
    closeIdleConnections: vi.fn(() => {
      events.push('closeIdleConnections')
      if (closesWhenIdle)
        onClosed?.()
    }),
    closeAllConnections: vi.fn(() => {
      events.push('closeAllConnections')
      onClosed?.()
    }),
  }
}

function steps(events: string[], inFlight: InFlightRequests, server: ReturnType<typeof fakeServer>): ShutdownSteps {
  return {
    beginShutdown: () => events.push('beginShutdown'),
    inFlight,
    server: server as unknown as ShutdownSteps['server'],
    closeApplication: async () => {
      events.push('closeApplication')
    },
    timeoutMs: 1_000,
    logger: createRootLogger({ level: 'silent' }),
  }
}

describe('shutdownGracefully', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('没有在途请求：按顺序停止接收、关闭空闲连接、关闭应用，结果为正常退出', async () => {
    const events: string[] = []
    const server = fakeServer(events)
    const result = await shutdownGracefully(steps(events, new InFlightRequests(), server))
    expect(result).toBe('graceful')
    expect(events).toEqual(['beginShutdown', 'close', 'closeIdleConnections', 'closeApplication'])
    expect(server.closeAllConnections).not.toHaveBeenCalled()
  })

  it('等在途请求完成之后才关闭应用', async () => {
    const events: string[] = []
    const inFlight = new InFlightRequests()
    const { EventEmitter } = await import('node:events')
    const response = Object.assign(new EventEmitter(), { headersSent: false, setHeader: vi.fn() })
    inFlight.middleware()({} as never, response as never, () => {})
    const shutdown = shutdownGracefully(steps(events, inFlight, fakeServer(events)))
    await vi.advanceTimersByTimeAsync(500)
    expect(events).not.toContain('closeApplication')
    expect(response.setHeader).toHaveBeenCalledWith('Connection', 'close')
    response.emit('finish')
    expect(await shutdown).toBe('graceful')
    expect(events.at(-1)).toBe('closeApplication')
  })

  it('在途请求超过时限：强制断开，结果为强制退出，仍然关闭应用', async () => {
    const events: string[] = []
    const inFlight = new InFlightRequests()
    const { EventEmitter } = await import('node:events')
    inFlight.middleware()({} as never, Object.assign(new EventEmitter(), { headersSent: true, setHeader: vi.fn() }) as never, () => {})
    const server = fakeServer(events)
    const shutdown = shutdownGracefully(steps(events, inFlight, server))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await shutdown).toBe('forced')
    expect(server.closeAllConnections).toHaveBeenCalledOnce()
    expect(events.at(-1)).toBe('closeApplication')
  })

  it('请求都完成了但还有连接没关（例如新请求正在传输）：到时限后强制断开', async () => {
    const events: string[] = []
    const server = fakeServer(events, false)
    const shutdown = shutdownGracefully(steps(events, new InFlightRequests(), server))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await shutdown).toBe('forced')
    expect(server.closeAllConnections).toHaveBeenCalledOnce()
  })
})
